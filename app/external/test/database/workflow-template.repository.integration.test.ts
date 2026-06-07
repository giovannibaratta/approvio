import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, WorkflowTemplateDbRepository, KmsModule, ConfigModule} from "@external"
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
      imports: [ConfigModule, KmsModule],
      providers: [WorkflowTemplateDbRepository, DatabaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

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

  describe("database encryption of sensitive actions field", () => {
    it("should encrypt the actions field in the database but retrieve it decrypted via the repository", async () => {
      // Given
      const space = await createMockSpaceInDb(prisma)
      const testActions = [
        {
          type: "EMAIL",
          recipients: ["user@approvio.com"],
          subject: "Test subject",
          body: "Test body"
        }
      ]

      // When: We create a workflow template with actions
      const template = await createMockWorkflowTemplateInDb(prisma, {
        spaceId: space.id,
        actions: testActions
      })

      // Then: Querying via the repository decrypts it
      const dbTemplateResult = await repository.getWorkflowTemplateById(template.id)()
      expect(dbTemplateResult).toBeRight()
      const dbTemplate = unwrapRight(dbTemplateResult)
      expect(dbTemplate.actions).toEqual(testActions)

      // And: Querying directly via raw SQL retrieves the encrypted JSON envelope
      const rawTemplates = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        "SELECT actions FROM workflow_templates WHERE id = $1::uuid",
        template.id
      )
      expect(rawTemplates).toHaveLength(1)
      const rawTemplate = rawTemplates[0]
      expect(rawTemplate).toBeDefined()
      expect(rawTemplate!.actions).toEqual({
        __encrypted_v1: expect.any(String)
      })
    })
  })
})
