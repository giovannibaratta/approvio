import {ConfigModule, KmsModule} from "@external"
import {MockConfigProvider} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {VoteFactory, WorkflowStatus} from "@domain"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {VoteTenantClient} from "@external/database/tenant-database-clients"
import {VoteDbRepository} from "@external/database/vote.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {
  createDomainMockUserInDb,
  createMockAgentInDb,
  createMockWorkflowInDb,
  ensureTestOrganization
} from "@test/mock-data"

describe("VoteDbRepository integration", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let database: DatabaseClient
  let repository: VoteDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>
  let workflowId: string
  let userId: string

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [
        VoteDbRepository,
        DatabaseClient,
        VoteTenantClient,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: connectionString,
          databaseRetry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
        })
      )
      .compile()
    database = module.get(DatabaseClient)
    repository = module.get(VoteDbRepository)
    await module.init()
    prisma = createFixturePrismaClient(connectionString)
    organizationId = randomOrgId()
    const user = await createDomainMockUserInDb(prisma, {organizationId})
    const workflow = await createMockWorkflowInDb(prisma, {
      organizationId,
      name: "Vote boundary",
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
      expiresAt: "active"
    })
    workflowId = workflow.id
    userId = user.id
  }, 30_000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  describe("getVotesByWorkflowId", () => {
    it("rejects a stored vote with both user and agent voters", async () => {
      // Given: A workflow, a user, and an agent
      const agent = await createMockAgentInDb(prisma, {organizationId})
      // Manually create a corrupted vote row with both userId and agentId
      await prisma.vote.create({
        data: {
          id: uuidv7(),
          organizationId,
          workflowId,
          userId,
          agentId: agent.id,
          voteType: "APPROVE",
          votedForGroups: [uuidv7()],
          createdAt: new Date()
        }
      })

      // When: Fetching votes for the workflow
      const result = await database.transactional({type: "organization", organizationId}, () =>
        repository.getVotesByWorkflowId({organizationId}, workflowId)()
      )

      // Expect: A mapping error due to conflicting voter entities
      expect(result).toBeLeftOf("vote_conflicting_voter_entities")
    })

    it("does not expose votes to another organization", async () => {
      // Given
      const vote = unwrapRight(
        VoteFactory.newVote({
          organizationId,
          workflowId,
          voter: {organizationId, entityId: userId, entityType: "user"},
          type: "APPROVE",
          votedForGroups: [uuidv7()]
        })
      )
      unwrapRight(
        await database.transactional({type: "organization", organizationId}, () =>
          repository.persistVoteAndMarkWorkflowRecalculation({organizationId}, vote)()
        )
      )
      const otherOrganizationId = randomOrgId()
      await ensureTestOrganization(prisma, otherOrganizationId)

      // When
      const result = await database.transactional({type: "organization", organizationId: otherOrganizationId}, () =>
        repository.getVotesByWorkflowId({organizationId: otherOrganizationId}, workflowId)()
      )

      // Expect
      expect(unwrapRight(result)).toEqual([])
    })
  })
})
