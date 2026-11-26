import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {WORKER_DATABASE_CORE_TOKEN} from "@external/database/worker-database-core.token"
import {WORKER_OUTBOX_REPOSITORY_TOKEN} from "@services/durable-work/interfaces"
import {WORKER_TRANSACTION_MANAGER_TOKEN} from "@services/transaction/interfaces"
import {WorkerDatabaseClient} from "@external/database/capability-database-client"
import {WorkerOutboxDbRepository} from "@external/database/worker-outbox.repository"
import {WorkerOutboxService} from "@services/durable-work/worker-outbox.service"
import {PrismaWorkerTransactionManager} from "@external/database/worker-transaction-manager"
import {VoteService} from "@services/vote/vote.service"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {outboxRecoveryCriteria} from "@services/durable-work/tenant-outbox.utils"
import {v7 as uuidv7} from "uuid"
import {ApprovalRuleType, SystemRole, WorkflowStatus} from "@domain"
import {QuotaService} from "@services/quota/quota.service"
import "@utils/matchers"
import {AuthService} from "@services/auth/auth.service"
import {QueueService} from "@services/queue/queue.service"
import {TENANT_OUTBOX_REPOSITORY_TOKEN, TenantOutboxRepository} from "@services/durable-work/interfaces"
import {createMockWorkflowInDb, createMockWorkflowTemplateInDb, createTestGroup} from "@test/mock-data"
import {
  failTaskEither,
  failTaskEitherAfterSuccess,
  observeTaskEither,
  rejectTaskEither,
  succeedTaskEither
} from "@test/injectors"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  dropPreparedDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb, TestTokenBuilder} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import {getQueueToken} from "@nestjs/bull"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external/queue/queue.module"
import {Queue} from "bull"
import request from "supertest"

jest.setTimeout(15000)

describe("Vote API transaction and publication", () => {
  let workerModule: TestingModule
  let workerTransactions: PrismaWorkerTransactionManager
  let workerOutbox: WorkerOutboxService
  let connection: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken
  let endpoint: string

  beforeAll(async () => {
    connection = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    const tenantUrl = new URL(connection)
    tenantUrl.username = "approvio_tenant"
    const platformUrl = new URL(connection)
    platformUrl.username = "approvio_platform"
    const apiConfig = MockConfigProvider.fromTenantConnectionUrl(tenantUrl.toString(), redisPrefix)
    apiConfig.databaseConfig.platformConnectionUrl = platformUrl.toString()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(apiConfig)
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(connection)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    const config = MockConfigProvider.fromTenantConnectionUrl(connection, redisPrefix)
    workerModule = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        WorkerDatabaseClient,
        WorkerOutboxDbRepository,
        WorkerOutboxService,
        PrismaWorkerTransactionManager,
        {provide: ConfigProvider, useValue: config},
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_worker_runtime"},
        {provide: WORKER_DATABASE_CORE_TOKEN, useExisting: DatabaseClient},
        {provide: WORKER_OUTBOX_REPOSITORY_TOKEN, useExisting: WorkerOutboxDbRepository},
        {provide: WORKER_TRANSACTION_MANAGER_TOKEN, useExisting: PrismaWorkerTransactionManager}
      ]
    }).compile()
    workerTransactions = workerModule.get(PrismaWorkerTransactionManager)
    workerOutbox = workerModule.get(WorkerOutboxService)
    await workerModule.init()
    await app.init()
  }, 30000)

  beforeEach(async () => {
    owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    endpoint = `/o/${owner.user.organizationId}`
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await workerModule.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  })

  afterEach(() => jest.restoreAllMocks())

  async function votingFixture(requireHighPrivilege = false) {
    const organizationId = owner.user.organizationId
    const group = await createTestGroup(prisma, {organizationId})
    const template = await createMockWorkflowTemplateInDb(prisma, {
      organizationId,
      approvalRule: {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: group.id,
        minCount: 1,
        requireHighPrivilege
      }
    })
    const voter = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      organizationId,
      roles: [SystemRole.createWorkflowTemplateVoterRole({type: "org", organizationId})]
    })
    await prisma.groupMembership.create({
      data: {
        organizationId,
        groupId: group.id,
        userId: voter.user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const workflow = await createMockWorkflowInDb(prisma, {
      organizationId,
      workflowTemplateId: template.id,
      name: "Vote-transaction",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      expiresAt: "active"
    })
    const vote = () =>
      request(app.getHttpServer())
        .post(`${endpoint}/workflows/${workflow.id}/vote`)
        .set("Authorization", `Bearer ${voter.token}`)
        .send({voteType: {type: "WITHDRAW"}})
    return {workflow, template, voter, group, vote}
  }

  it("rejects an organization mismatch without persisting a vote", async () => {
    // Given
    const before = await prisma.vote.count()

    // When
    const result = await app.get(VoteService).canVote({
      organizationId: randomOrgId(),
      workflowId: uuidv7(),
      requestor: {
        entityType: "user",
        user: owner.user,
        providerId: "custom",
        sessionId: uuidv7(),
        sessionContextVersion: 0n
      }
    })()

    // Expect
    expect(result).toBeLeftOf("organization_mismatch")
    expect(await prisma.vote.count()).toBe(before)
  })

  it("commits the vote, recalculation flag and event before queue publication", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const queue = app.get(QueueService)
    const committedVotesAtPublication = observeTaskEither(queue, "enqueue", () =>
      prisma.vote.count({where: {workflowId: workflow.id}})
    )

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(committedVotesAtPublication).toEqual([1])
    expect(await prisma.vote.findFirstOrThrow({where: {workflowId: workflow.id}})).toMatchObject({voteType: "WITHDRAW"})
    expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toMatchObject({
      recalculationRequired: true
    })
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      organizationId: owner.user.organizationId,
      eventType: "workflow.recalculate",
      publishedAt: expect.any(Date)
    })
  })

  it.each(["active", "expired"] as const)("preserves a %s relay lease during fast-path publication", async state => {
    // Given
    const {workflow, vote} = await votingFixture()
    const queue = app.get(QueueService)
    const leaseOwner = uuidv7()
    const leaseUntil = new Date(Date.now() + (state === "active" ? 60_000 : -60_000))
    observeTaskEither(queue, "enqueue", async event => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: event.organizationId, eventId: event.eventId}},
        data: {leaseOwner, leaseUntil, attempts: 1n}
      })
    })

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null,
      leaseOwner,
      leaseUntil,
      attempts: 1n
    })
  })

  it("preserves a relay claim acquired between the publication read and write", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const outbox = app.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN)
    const leaseOwner = uuidv7()
    const claimsAtPublication = observeTaskEither(outbox, "tryMarkPublished", async (context, eventId) => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
        data: {createdAt: new Date(Date.now() - 11 * 60_000)}
      })
      const claims = await workerTransactions.execute(context, () =>
        workerOutbox.claim(context, outboxRecoveryCriteria(leaseOwner, new Date(), 10))
      )()
      return unwrapRight(claims).length
    })

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(claimsAtPublication).toEqual([1])
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null,
      leaseOwner,
      attempts: 1n
    })
  })

  it("keeps a competing publication timestamp when the fast-path write loses its race", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const outbox = app.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN)
    const publishedAt = new Date(Date.now() - 1_000)
    observeTaskEither(outbox, "tryMarkPublished", async (context, eventId) => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
        data: {publishedAt}
      })
    })

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt,
      leaseOwner: null
    })
  })

  it("rolls back the vote and recalculation flag when outbox persistence fails", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const before = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})
    rejectTaskEither(
      app.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN),
      "append",
      new Error("Outbox persistence failed")
    )

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
    expect(await prisma.tenantOutbox.count({where: {resourceId: workflow.id}})).toBe(0)
    expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual(before)
    const queue = app.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"])
    expect(jobs.filter(job => job.data.workflowId === workflow.id)).toHaveLength(0)
  })

  it("keeps the committed vote and pending event when queue publication fails", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    failTaskEither(app.get(QueueService), "enqueue", "unknown_error")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(1)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null
    })
  })

  it("keeps the committed vote and pending event when publication acknowledgement fails", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const outbox = app.get<TenantOutboxRepository>(TENANT_OUTBOX_REPOSITORY_TOKEN)
    failTaskEitherAfterSuccess(outbox, "tryMarkPublished", "organization_mismatch")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(1)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null
    })
    const queue = app.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))
    const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"])
    expect(jobs.filter(job => job.data.workflowId === workflow.id)).toHaveLength(1)
  })

  it("rejects an expired workflow without persisting a vote or recalculation event", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    // Preserve a valid lifecycle: creation precedes the deadline, and the deadline has passed.
    // A deadline before creation would fail domain validation instead of exercising vote expiry.
    const now = Date.now()
    await prisma.workflow.update({
      where: {id: workflow.id},
      data: {createdAt: new Date(now - 120000), expiresAt: new Date(now - 60000), updatedAt: new Date(now)}
    })
    const before = await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})

    // When
    const response = await vote()

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(response.body).toHaveErrorCode("WORKFLOW_EXPIRED")
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
    expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual(before)
    expect(await prisma.tenantOutbox.count({where: {resourceId: workflow.id}})).toBe(0)
  })

  it("rejects exhausted quota before consuming a privilege receipt", async () => {
    // Given
    const {workflow, voter} = await votingFixture(true)
    succeedTaskEither(app.get(QuotaService), "isQuotaAvailable", false)
    const session = await prisma.browserSession.findFirstOrThrow({where: {accountId: voter.user.accountId}})
    const jti = uuidv7()
    const organizationId = voter.user.organizationId
    await prisma.stepUpReceipt.create({
      data: {
        id: uuidv7(),
        organizationId,
        jti,
        userId: voter.user.id,
        sessionId: session.id,
        providerId: session.providerId,
        contextVersion: session.contextVersion,
        operation: "vote",
        resourceId: workflow.id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date()
      }
    })
    const token = TestTokenBuilder.signUserToken(jwtService, configProvider, voter.user, {
      sessionId: session.id,
      providerId: session.providerId,
      contextVersion: session.contextVersion,
      stepUpContext: {jti, operation: "vote", resource: workflow.id}
    })

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/workflows/${workflow.id}/vote`)
      .set("Authorization", `Bearer ${token}`)
      .send({voteType: {type: "WITHDRAW"}})

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("QUOTA_EXCEEDED")
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
    expect(
      await prisma.stepUpReceipt.findUniqueOrThrow({where: {organizationId_jti: {organizationId, jti}}})
    ).toMatchObject({
      consumedAt: null
    })
  })

  it("rejects a required privilege receipt failure before persistence", async () => {
    // Given
    const {workflow, vote} = await votingFixture(true)
    failTaskEither(app.get(AuthService), "useHighPrivilegeToken", "invalid_credential")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
    expect(response.body.code).toBe("INVALID_CREDENTIAL")
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
  })

  it.each([true, false])("uses only the selected APPROVE group for privilege: required=%s", async required => {
    // Given
    const {workflow, template, voter, group} = await votingFixture(required)
    const other = await createTestGroup(prisma, {organizationId: owner.user.organizationId})
    await prisma.groupMembership.create({
      data: {
        organizationId: owner.user.organizationId,
        groupId: other.id,
        userId: voter.user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    await prisma.workflowTemplate.update({
      where: {id: template.id},
      data: {
        approvalRule: {
          type: ApprovalRuleType.OR,
          rules: [
            {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: group.id, minCount: 1, requireHighPrivilege: required},
            {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: other.id, minCount: 1, requireHighPrivilege: !required}
          ]
        }
      }
    })

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/workflows/${workflow.id}/vote`)
      .set("Authorization", `Bearer ${voter.token}`)
      .send({voteType: {type: "APPROVE", votedForGroups: [group.id]}})

    // Expect
    expect(response.status).toBe(required ? HttpStatus.FORBIDDEN : HttpStatus.ACCEPTED)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(required ? 0 : 1)
  })
})
