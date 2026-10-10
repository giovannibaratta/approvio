import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {unwrapRight} from "@utils/either"
import {outboxRecoveryCriteria} from "@services/durable-work/tenant-outbox.utils"
import {v7 as uuidv7} from "uuid"
import {ApprovalRuleType, SystemRole, WorkflowStatus} from "@domain"
import {QuotaService} from "@services/quota/quota.service"
import "@utils/matchers"
import {AuthService} from "@services/auth/auth.service"
import {QueueService} from "@services/queue/queue.service"
import {OUTBOX_REPOSITORY_TOKEN, OutboxRepository} from "@services/durable-work/interfaces"
import {createMockWorkflowInDb, createMockWorkflowTemplateInDb, createTestGroup} from "@test/mock-data"
import * as TE from "fp-ts/TaskEither"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
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
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import request from "supertest"

jest.setTimeout(15000)

describe("Vote API transaction and publication", () => {
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
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(connection, redisPrefix))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(connection)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
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

  it("commits the vote, recalculation flag and event before queue publication", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    const queue = app.get(QueueService)
    const enqueue = queue.enqueue.bind(queue)
    let committedVotesAtPublication = 0
    jest.spyOn(queue, "enqueue").mockImplementation(event => async () => {
      committedVotesAtPublication = await prisma.vote.count({where: {workflowId: workflow.id}})
      return enqueue(event)()
    })

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(committedVotesAtPublication).toBe(1)
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
    const {workflow, vote} = await votingFixture()
    const queue = app.get(QueueService)
    const enqueue = queue.enqueue.bind(queue)
    const leaseOwner = uuidv7()
    const leaseUntil = new Date(Date.now() + (state === "active" ? 60_000 : -60_000))
    jest.spyOn(queue, "enqueue").mockImplementation(event => async () => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: event.organizationId, eventId: event.eventId}},
        data: {leaseOwner, leaseUntil, attempts: 1}
      })
      return enqueue(event)()
    })

    const response = await vote()

    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null,
      leaseOwner,
      leaseUntil,
      attempts: 1
    })
  })

  it("preserves a relay claim acquired between the publication read and write", async () => {
    const {workflow, vote} = await votingFixture()
    const outbox = app.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    const tryMarkPublished = outbox.tryMarkPublished.bind(outbox)
    const leaseOwner = uuidv7()
    jest.spyOn(outbox, "tryMarkPublished").mockImplementation((context, eventId, at) => async () => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
        data: {createdAt: new Date(Date.now() - 11 * 60_000)}
      })
      const claims = await app
        .get<TenantTransactionManager>(WORKER_TRANSACTION_MANAGER_TOKEN)
        .execute(context, () => outbox.claim(context, outboxRecoveryCriteria(leaseOwner, new Date(), 10)))()
      expect(unwrapRight(claims)).toHaveLength(1)
      return tryMarkPublished(context, eventId, at)()
    })

    const response = await vote()

    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null,
      leaseOwner,
      attempts: 1
    })
  })

  it("keeps a competing publication timestamp when the fast-path write loses its race", async () => {
    const {workflow, vote} = await votingFixture()
    const outbox = app.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN)
    const tryMarkPublished = outbox.tryMarkPublished.bind(outbox)
    const publishedAt = new Date(Date.now() - 1_000)
    jest.spyOn(outbox, "tryMarkPublished").mockImplementation((context, eventId, at) => async () => {
      await prisma.tenantOutbox.update({
        where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
        data: {publishedAt}
      })
      return tryMarkPublished(context, eventId, at)()
    })

    const response = await vote()

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
    jest
      .spyOn(app.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN), "append")
      .mockReturnValueOnce(TE.fromTask(() => Promise.reject(new Error("Outbox persistence failed"))))
    const publication = jest.spyOn(app.get(QueueService), "enqueue")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
    expect(await prisma.tenantOutbox.count({where: {resourceId: workflow.id}})).toBe(0)
    expect(await prisma.workflow.findUniqueOrThrow({where: {id: workflow.id}})).toEqual(before)
    expect(publication).not.toHaveBeenCalled()
  })

  it("keeps the committed vote and pending event when queue publication fails", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    jest.spyOn(app.get(QueueService), "enqueue").mockReturnValueOnce(TE.left("unknown_error"))

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
    jest
      .spyOn(app.get<OutboxRepository>(OUTBOX_REPOSITORY_TOKEN), "tryMarkPublished")
      .mockReturnValueOnce(TE.left("organization_mismatch"))
    const publication = jest.spyOn(app.get(QueueService), "enqueue")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.ACCEPTED)
    expect(publication).toHaveBeenCalledTimes(1)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(1)
    expect(await prisma.tenantOutbox.findFirstOrThrow({where: {resourceId: workflow.id}})).toMatchObject({
      publishedAt: null
    })
  })

  it("rejects an expired workflow before checking quota or persisting a vote", async () => {
    // Given
    const {workflow, vote} = await votingFixture()
    // Preserve a valid lifecycle: creation precedes the deadline, and the deadline has passed.
    // A deadline before creation would fail domain validation instead of exercising vote expiry.
    const now = Date.now()
    await prisma.workflow.update({
      where: {id: workflow.id},
      data: {createdAt: new Date(now - 120000), expiresAt: new Date(now - 60000), updatedAt: new Date(now)}
    })
    const quota = jest.spyOn(app.get(QuotaService), "isQuotaAvailable")

    // When
    const response = await vote()

    // Expect
    expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(response.body).toHaveErrorCode("WORKFLOW_EXPIRED")
    expect(quota).not.toHaveBeenCalled()
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
  })

  it("rejects exhausted quota before consuming a privilege receipt", async () => {
    // Given
    const {workflow, vote} = await votingFixture(true)
    jest.spyOn(app.get(QuotaService), "isQuotaAvailable").mockReturnValueOnce(TE.right(false))
    const privilege = jest.spyOn(app.get(AuthService), "useHighPrivilegeToken")

    // When
    const response = await vote()

    // Expect
    expect(response.status).toBe(HttpStatus.FORBIDDEN)
    expect(response.body.code).toBe("QUOTA_EXCEEDED")
    expect(privilege).not.toHaveBeenCalled()
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(0)
  })

  it("rejects a required privilege receipt failure before persistence", async () => {
    // Given
    const {workflow, vote} = await votingFixture(true)
    jest.spyOn(app.get(AuthService), "useHighPrivilegeToken").mockReturnValueOnce(TE.left("invalid_credential"))

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
    const privilege = jest.spyOn(app.get(AuthService), "useHighPrivilegeToken")

    // When
    const response = await request(app.getHttpServer())
      .post(`${endpoint}/workflows/${workflow.id}/vote`)
      .set("Authorization", `Bearer ${voter.token}`)
      .send({voteType: {type: "APPROVE", votedForGroups: [group.id]}})

    // Expect
    expect(response.status).toBe(required ? HttpStatus.FORBIDDEN : HttpStatus.ACCEPTED)
    expect(privilege).toHaveBeenCalledTimes(required ? 1 : 0)
    expect(await prisma.vote.count({where: {workflowId: workflow.id}})).toBe(required ? 0 : 1)
  })
})
