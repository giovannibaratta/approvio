import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {Node} from "@domain/hierarchy"
import {HierarchyService} from "@services/hierarchy/hierarchy.service"
import {Test, TestingModule} from "@nestjs/testing"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {
  MockConfigProvider,
  createMockSpaceInDb,
  createMockWorkflowTemplateInDb,
  createMockWorkflowInDb,
  createTestGroup
} from "@test/mock-data"
import {ConfigProvider} from "@external/config"
import {PrismaClient} from "@prisma/client"
import {unwrapRight} from "@utils/either"

const organizationId = randomOrgId()

describe("HierarchyService Integration Tests", () => {
  let module: TestingModule
  let hierarchyService: HierarchyService
  let prisma: PrismaClient

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    try {
      module = await Test.createTestingModule({
        imports: [ConfigModule, ServiceModule.register({runtime: "api"})]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error("Error while initializing module", error)
      throw error
    }

    hierarchyService = module.get<HierarchyService>(HierarchyService)
    prisma = createFixturePrismaClient(isolatedDb)
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
    const node: Node = {type: "Org", identifier: toOrganizationId("0198ed6b-0c41-7000-8000-000000000001")}

    // When
    const context = {organizationId}
    const result = await hierarchyService.getParents(node, context)()

    // Then
    expect(unwrapRight(result)).toEqual([])
  })

  it("should return Org as parent for Group", async () => {
    // Given
    const group = await createTestGroup(prisma, {organizationId})
    const node: Node = {type: "Group", identifier: group.id}

    // When
    const result = await hierarchyService.getParents(node, {organizationId})()

    // Then
    expect(unwrapRight(result)).toEqual([{type: "Org", identifier: organizationId}])
  })

  it("should return Org as parent for Space", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma, {organizationId})
    const node: Node = {type: "Space", identifier: space.id}

    // When
    const result = await hierarchyService.getParents(node, {organizationId})()

    // Then
    expect(unwrapRight(result)).toEqual([{type: "Org", identifier: organizationId}])
  })

  it("should return [Space, Org] as parents for WorkflowTemplate", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma, {organizationId})
    const template = await createMockWorkflowTemplateInDb(prisma, {organizationId, spaceId: space.id})
    const node: Node = {type: "WorkflowTemplate", identifier: template.id}

    // When
    const context = {organizationId}
    const result = await hierarchyService.getParents(node, context)()

    // Then
    expect(unwrapRight(result)).toEqual([
      {type: "Space", identifier: space.id},
      {type: "Org", identifier: organizationId}
    ])
  })

  it("should return [WorkflowTemplate, Space, Org] as parents for Workflow", async () => {
    // Given
    const space = await createMockSpaceInDb(prisma, {organizationId})
    const template = await createMockWorkflowTemplateInDb(prisma, {organizationId, spaceId: space.id})
    const workflow = await createMockWorkflowInDb(prisma, {
      name: "Test Workflow",
      organizationId,
      workflowTemplateId: template.id
    })
    const node: Node = {type: "Workflow", identifier: workflow.id}

    // When
    const context = {organizationId}
    const result = await hierarchyService.getParents(node, context)()

    // Then
    expect(unwrapRight(result)).toEqual([
      {type: "WorkflowTemplate", identifier: template.id},
      {type: "Space", identifier: space.id},
      {type: "Org", identifier: organizationId}
    ])
  })
})
