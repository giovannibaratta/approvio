import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, WorkflowTemplateDbRepository} from "@external"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockSpaceInDb, createMockWorkflowTemplateInDb} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("WorkflowTemplateDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: WorkflowTemplateDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowTemplateDbRepository,
        DatabaseClient,
        {
          provide: ConfigProvider,
          useValue: MockConfigProvider.fromDbConnectionUrl(isolatedDb)
        }
      ]
    }).compile()

    prisma = module.get(DatabaseClient).prisma
    repository = module.get(WorkflowTemplateDbRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("countUniqueWorkflowTemplatesBySpaceId", () => {
    it("should count unique template names correctly (ignoring versions)", async () => {
      // Given
      const space = await createMockSpaceInDb(prisma)
      const otherSpace = await createMockSpaceInDb(prisma)
      const spaceId = space.id
      const otherSpaceId = otherSpace.id

      // Template A: 2 versions in spaceId
      await createMockWorkflowTemplateInDb(prisma, {name: "Template A", version: 1, spaceId})
      await createMockWorkflowTemplateInDb(prisma, {name: "Template A", version: 2, spaceId})

      // Template B: 1 version in spaceId
      await createMockWorkflowTemplateInDb(prisma, {name: "Template B", version: 1, spaceId})

      // Template C: 1 version in otherSpaceId
      await createMockWorkflowTemplateInDb(prisma, {name: "Template C", version: 1, spaceId: otherSpaceId})

      // When
      const count = unwrapRight(await repository.countUniqueWorkflowTemplatesBySpaceId(spaceId)())

      // Expect: Should be 2 (Template A and Template B)
      expect(count).toBe(2)
    })
  })
})
