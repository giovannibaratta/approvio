import {Node} from "@domain/hierarchy"
import {HierarchyService} from "@services/hierarchy/hierarchy.service"
import {DEFAULT_ORG_ID} from "@services"
import {Test, TestingModule} from "@nestjs/testing"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  MockConfigProvider,
  createMockSpaceInDb,
  createMockWorkflowTemplateInDb,
  createMockWorkflowInDb,
  createTestGroup
} from "@test/mock-data"
import {ConfigProvider} from "@external/config"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {unwrapRight} from "@utils/either"

describe("HierarchyService Integration Tests", () => {
  let module: TestingModule
  let hierarchyService: HierarchyService
  let prisma: PrismaClient

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    try {
      module = await Test.createTestingModule({
        imports: [ConfigModule, ServiceModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error("Error while initializing module", error)
      throw error
    }

    hierarchyService = module.get<HierarchyService>(HierarchyService)
    prisma = module.get(DatabaseClient).prisma
  })

  afterAll(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
  })

  it("should return empty parents for Org", async () => {
    // Given
    const node: Node = {type: "Org", identifier: "1"}

    // When
    const result = await hierarchyService.getParents(node)()

    // Then
    expect(unwrapRight(result)).toEqual([])
  })

  it("should return Org as parent for Group", async () => {
    // Given
    const group = await createTestGroup(prisma)
    const node: Node = {type: "Group", identifier: group.id}

    // When
    const result = await hierarchyService.getParents(node)()

    // Then
    expect(unwrapRight(result)).toEqual([{type: "Org", identifier: DEFAULT_ORG_ID}])
  })

  it("should return Org as parent for Space", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma)
    const node: Node = {type: "Space", identifier: space.id}

    // When
    const result = await hierarchyService.getParents(node)()

    // Then
    expect(unwrapRight(result)).toEqual([{type: "Org", identifier: DEFAULT_ORG_ID}])
  })

  it("should return [Space, Org] as parents for WorkflowTemplate", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma)
    const template = await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id})
    const node: Node = {type: "WorkflowTemplate", identifier: template.id}

    // When
    const result = await hierarchyService.getParents(node)()

    // Then
    expect(unwrapRight(result)).toEqual([
      {type: "Space", identifier: space.id},
      {type: "Org", identifier: DEFAULT_ORG_ID}
    ])
  })

  it("should return [WorkflowTemplate, Space, Org] as parents for Workflow", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma)
    const template = await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id})
    const workflow = await createMockWorkflowInDb(prisma, {
      name: "Test Workflow",
      workflowTemplateId: template.id
    })
    const node: Node = {type: "Workflow", identifier: workflow.id}

    // When
    const result = await hierarchyService.getParents(node)()

    // Then
    expect(unwrapRight(result)).toEqual([
      {type: "WorkflowTemplate", identifier: template.id},
      {type: "Space", identifier: space.id},
      {type: "Org", identifier: DEFAULT_ORG_ID}
    ])
  })
})
