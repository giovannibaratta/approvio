import {Node, QuotaFactory, QuotaIdentifier, WorkflowStatus} from "@domain"
import {DEFAULT_ORG_ID, QuotaRepository, QuotaService} from "@services"
import {isRight} from "fp-ts/Either"
import {randomUUID} from "crypto"

import {Test, TestingModule} from "@nestjs/testing"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"
import {QUOTA_REPOSITORY_TOKEN} from "@services/quota/interfaces"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {
  MockConfigProvider,
  createMockSpaceInDb,
  createMockWorkflowTemplateInDb,
  createTestGroup,
  createDomainMockUserInDb,
  createMockAgentInDb,
  createMockWorkflowInDb,
  createMockUserInDb
} from "@test/mock-data"
import {ConfigProvider} from "@external/config"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {unwrapRight} from "@utils/either"

describe("Quota Integration Tests", () => {
  let module: TestingModule
  let quotaService: QuotaService
  let quotaRepo: QuotaRepository
  let prisma: PrismaClient
  const testOrgNode: Node = {type: "Org", identifier: DEFAULT_ORG_ID}

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    module = await Test.createTestingModule({
      imports: [ConfigModule, ServiceModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

    quotaService = module.get<QuotaService>(QuotaService)
    quotaRepo = module.get<QuotaRepository>(QUOTA_REPOSITORY_TOKEN)
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

  const upsertQuotaHelper = async (identifier: QuotaIdentifier, limit: number) => {
    const existingResult = await quotaRepo.getQuota(identifier)()
    let occ: bigint | undefined

    if (isRight(existingResult)) occ = existingResult.right.occ

    const quotaResult = unwrapRight(QuotaFactory.newQuota(identifier, limit))

    if (occ !== undefined) await quotaRepo.updateQuota(quotaResult, occ)()
    else await quotaRepo.createQuota(quotaResult)()
  }

  it("should enforce global MAX_GROUPS quota", async () => {
    // Given
    // 1. Set global quota for groups to 1
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_GROUPS"}, 1)
    // 2. Create one group
    await createTestGroup(prisma, {name: "Group 1"})

    // When
    // 3. Check quota - should be at limit (usage 1, limit 1 -> returns false as usage < limit is false)
    const result1 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_GROUPS")()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 4. Increase quota to 2
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_GROUPS"}, 2)

    // When
    const result2 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_GROUPS")()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce scoped MAX_WORKFLOW_TEMPLATES_PER_SPACE quota", async () => {
    // Given
    // 1. Create a space
    const space = await createMockSpaceInDb(prisma, {name: "Space 1"})
    // 2. Set quota for TEMPLATES in SPACE scope to 1 for this specific space.
    await upsertQuotaHelper(
      {node: {type: "Space", identifier: space.id}, quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"},
      1
    )
    // 3. Create one template in the space
    await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id, name: "Template 1"})

    // When
    // 4. Check quota for this space
    const result1 = await quotaService.isQuotaAvailable(
      {type: "Space", identifier: space.id},
      "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
    )()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 5. Create another space and check quota there (should be 0 usage and no limit applied)
    const space2 = await createMockSpaceInDb(prisma, {name: "Space 2"})

    // When
    const result2 = await quotaService.isQuotaAvailable(
      {type: "Space", identifier: space2.id},
      "MAX_WORKFLOW_TEMPLATES_PER_SPACE"
    )()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce MAX_ROLES_PER_USER quota via global limit", async () => {
    // Given
    // 1. Create a user
    const user = await createDomainMockUserInDb(prisma, {email: "quota-user@example.com"})
    const userNode: Node = {type: "User", identifier: user.id}
    // 2. Set global quota for ROLES per USER to 0 (effectively preventing any role assignment)
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_ROLES_PER_USER"}, 0)

    // When
    // 3. Check quota for this user (should be false as 1 > 0 due to 1 default role in mock data)
    const result1 = await quotaService.isQuotaAvailable(userNode, "MAX_ROLES_PER_USER")()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 4. Increase global quota to 5
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_ROLES_PER_USER"}, 5)

    // When
    // 5. Check quota again (should be true as 1 < 5)
    const result2 = await quotaService.isQuotaAvailable(userNode, "MAX_ROLES_PER_USER")()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce MAX_ENTITIES_PER_GROUP quota", async () => {
    // Given
    // 1. Create a group
    const group = await createTestGroup(prisma, {name: "Group Entities"})
    // 2. Set quota for ENTITIES per GROUP to 1
    await upsertQuotaHelper({node: {type: "Group", identifier: group.id}, quotaType: "MAX_ENTITIES_PER_GROUP"}, 1)
    // 3. Add a user to the group
    const user = await createDomainMockUserInDb(prisma)
    await prisma.groupMembership.create({
      data: {
        groupId: group.id,
        userId: user.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })

    // When
    // 4. Check quota (usage 1, limit 1 -> should fail)
    const result1 = await quotaService.isQuotaAvailable(
      {type: "Group", identifier: group.id},
      "MAX_ENTITIES_PER_GROUP"
    )()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 5. Increase quota to 2
    await upsertQuotaHelper({node: {type: "Group", identifier: group.id}, quotaType: "MAX_ENTITIES_PER_GROUP"}, 2)

    // When
    // 6. Check quota (usage 1, limit 2 -> should pass)
    const result2 = await quotaService.isQuotaAvailable(
      {type: "Group", identifier: group.id},
      "MAX_ENTITIES_PER_GROUP"
    )()

    // Expect
    expect(result2).toBeRightOf(true)

    // Given
    // 7. Add an agent to the group
    const agent = await createMockAgentInDb(prisma)
    await prisma.agentGroupMembership.create({
      data: {
        groupId: group.id,
        agentId: agent.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })

    // When
    // 8. Check quota again (usage 2, limit 2 -> should fail as usage < limit is false)
    const result3 = await quotaService.isQuotaAvailable(
      {type: "Group", identifier: group.id},
      "MAX_ENTITIES_PER_GROUP"
    )()

    // Expect
    expect(result3).toBeRightOf(false)
  })

  it("should support checking for a specific amount in isQuotaAvailable", async () => {
    // Given
    // 1. Set global quota for groups to 5
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_GROUPS"}, 5)
    // 2. Create two groups (usage = 2)
    await createTestGroup(prisma, {name: "Group 1"})
    await createTestGroup(prisma, {name: "Group 2"})

    // When & Expect
    // 3. Can I add 1 more? (2 + 1 <= 5) -> Yes
    const canAdd1 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_GROUPS", 1)()
    expect(canAdd1).toBeRightOf(true)

    // 4. Can I add 3 more? (2 + 3 <= 5) -> Yes
    const canAdd3 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_GROUPS", 3)()
    expect(canAdd3).toBeRightOf(true)

    // 5. Can I add 4 more? (2 + 4 <= 5) -> No
    const canAdd4 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_GROUPS", 4)()
    expect(canAdd4).toBeRightOf(false)
  })

  it("should enforce MAX_SPACES quota at Org level", async () => {
    // Given: limit of 1 space
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_SPACES"}, 1)
    await createMockSpaceInDb(prisma, {name: "Space 1"})

    // When: check quota
    const result = await quotaService.isQuotaAvailable(testOrgNode, "MAX_SPACES")()

    // Expect: no more spaces allowed
    expect(result).toBeRightOf(false)

    // Given: limit increased to 2
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_SPACES"}, 2)

    // When: check quota
    const result2 = await quotaService.isQuotaAvailable(testOrgNode, "MAX_SPACES")()

    // Expect: space allowed
    expect(result2).toBeRightOf(true)
  })

  it("should enforce MAX_CONCURRENT_WORKFLOWS quota at WorkflowTemplate level", async () => {
    // Given: a template and a limit of 1 concurrent workflow
    const template = await createMockWorkflowTemplateInDb(prisma)
    const templateNode: Node = {type: "WorkflowTemplate", identifier: template.id}
    await upsertQuotaHelper({node: templateNode, quotaType: "MAX_CONCURRENT_WORKFLOWS"}, 1)

    // Create an active workflow for this template
    await createMockWorkflowInDb(prisma, {
      name: "Active Workflow",
      workflowTemplateId: template.id,
      status: WorkflowStatus.EVALUATION_IN_PROGRESS
    })

    // When: check quota
    const result = await quotaService.isQuotaAvailable(templateNode, "MAX_CONCURRENT_WORKFLOWS")()

    // Expect: no more workflows allowed for this template
    expect(result).toBeRightOf(false)
  })

  it("should enforce MAX_VOTES_PER_WORKFLOW quota at Workflow level", async () => {
    // Given: a workflow and a limit of 1 vote
    const workflow = await createMockWorkflowInDb(prisma, {name: "Workflow with votes"})
    const workflowNode: Node = {type: "Workflow", identifier: workflow.id}
    await upsertQuotaHelper({node: workflowNode, quotaType: "MAX_VOTES_PER_WORKFLOW"}, 1)

    // Create a user and a vote
    const user = await createMockUserInDb(prisma)
    await prisma.vote.create({
      data: {
        id: randomUUID(),
        workflowId: workflow.id,
        userId: user.id,
        voteType: "APPROVE",
        votedForGroups: [],
        createdAt: new Date()
      }
    })

    // When: check quota
    const result = await quotaService.isQuotaAvailable(workflowNode, "MAX_VOTES_PER_WORKFLOW")()

    // Expect: no more votes allowed
    expect(result).toBeRightOf(false)
  })

  it("should inherit quota from Org level to Space level and allow overrides", async () => {
    // Given: MAX_WORKFLOW_TEMPLATES_PER_SPACE set at Org level
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"}, 1)

    const space = await createMockSpaceInDb(prisma, {name: "Space with inheritance"})
    const spaceNode: Node = {type: "Space", identifier: space.id}

    // Create 1 template in this space (usage = 1)
    await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id, name: "Template 1"})

    // When: check quota at space level (should inherit limit 1 from Org)
    const result1 = await quotaService.isQuotaAvailable(spaceNode, "MAX_WORKFLOW_TEMPLATES_PER_SPACE")()

    // Expect: inherited limit reached
    expect(result1).toBeRightOf(false)

    // Given: override limit at Space level to 2
    await upsertQuotaHelper({node: spaceNode, quotaType: "MAX_WORKFLOW_TEMPLATES_PER_SPACE"}, 2)

    // When: check quota again
    const result2 = await quotaService.isQuotaAvailable(spaceNode, "MAX_WORKFLOW_TEMPLATES_PER_SPACE")()

    // Expect: override respected
    expect(result2).toBeRightOf(true)

    // Create another template (usage = 2)
    await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id, name: "Template 2"})

    // When: check quota again
    const result3 = await quotaService.isQuotaAvailable(spaceNode, "MAX_WORKFLOW_TEMPLATES_PER_SPACE")()

    // Expect: override limit reached
    expect(result3).toBeRightOf(false)
  })

  it("should handle deep inheritance (Org -> Space -> WorkflowTemplate)", async () => {
    // MAX_CONCURRENT_WORKFLOWS is evaluated at WorkflowTemplate level.
    // We can define it at Org level to apply to all templates.

    // Given: limit set at Org level
    await upsertQuotaHelper({node: testOrgNode, quotaType: "MAX_CONCURRENT_WORKFLOWS"}, 1)

    const space = await createMockSpaceInDb(prisma)
    const template = await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id})
    const templateNode: Node = {type: "WorkflowTemplate", identifier: template.id}

    // Create an active workflow
    await createMockWorkflowInDb(prisma, {
      name: "Workflow 1",
      workflowTemplateId: template.id,
      status: WorkflowStatus.EVALUATION_IN_PROGRESS
    })

    // When: check quota at template level
    const result = await quotaService.isQuotaAvailable(templateNode, "MAX_CONCURRENT_WORKFLOWS")()

    // Expect: inherited limit from Org reached
    expect(result).toBeRightOf(false)
  })
})
