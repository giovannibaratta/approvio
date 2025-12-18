import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, VoteDbRepository} from "@external"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createMockUserInDb, createMockAgentInDb, createMockWorkflowInDb, MockConfigProvider} from "@test/mock-data"
import "expect-more-jest"
import {randomUUID} from "crypto"

describe("VoteDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: VoteDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoteDbRepository,
        DatabaseClient,
        {
          provide: ConfigProvider,
          useValue: MockConfigProvider.fromDbConnectionUrl(isolatedDb)
        }
      ]
    }).compile()

    prisma = module.get(DatabaseClient)
    repository = module.get(VoteDbRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("getVotesByWorkflowId", () => {
    it("should return vote_conflicting_voter_entities when a vote has both user and agent ids", async () => {
      // Given: A workflow, a user, and an agent
      const user = await createMockUserInDb(prisma)
      const agent = await createMockAgentInDb(prisma)
      const workflow = await createMockWorkflowInDb(prisma, {name: "test-workflow"})

      // Manually create a corrupted vote row with both userId and agentId
      await prisma.vote.create({
        data: {
          id: randomUUID(),
          workflowId: workflow.id,
          userId: user.id,
          agentId: agent.id,
          voteType: "APPROVE",
          votedForGroups: ["group1"],
          createdAt: new Date()
        }
      })

      // When: Fetching votes for the workflow
      const result = await repository.getVotesByWorkflowId(workflow.id)()

      // Expect: A mapping error due to conflicting voter entities
      expect(result).toBeLeftOf("vote_conflicting_voter_entities")
    })
  })
})
