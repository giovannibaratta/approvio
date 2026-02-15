import {QuotaFactory, QuotaIdentifier} from "@domain"
import {QuotaRepository, QuotaService} from "@services"
import {isRight} from "fp-ts/lib/Either"

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
  createMockAgentInDb
} from "@test/mock-data"
import {ConfigProvider} from "@external/config"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"

describe("Quota Integration Tests", () => {
  let module: TestingModule
  let quotaService: QuotaService
  let quotaRepo: QuotaRepository
  let prisma: PrismaClient

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
    prisma = module.get(DatabaseClient)
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

    const quotaResult = QuotaFactory.newQuota(identifier, limit)
    if (!isRight(quotaResult)) throw new Error("Failed to create quota object")

    if (occ !== undefined) await quotaRepo.updateQuota(quotaResult.right, occ)()
    else await quotaRepo.createQuota(quotaResult.right)()
  }

  it("should enforce global MAX_GROUPS quota", async () => {
    // Given
    // 1. Set global quota for groups to 1
    await upsertQuotaHelper({scope: "GLOBAL", metric: "MAX_GROUPS"}, 1)
    // 2. Create one group
    await createTestGroup(prisma, {name: "Group 1"})

    // When
    // 3. Check quota - should be at limit (usage 1, limit 1 -> returns false as usage < limit is false)
    const result1 = await quotaService.isGlobalQuotaAvailable({scope: "GLOBAL", metric: "MAX_GROUPS"})()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 4. Increase quota to 2
    await upsertQuotaHelper({scope: "GLOBAL", metric: "MAX_GROUPS"}, 2)

    // When
    const result2 = await quotaService.isGlobalQuotaAvailable({scope: "GLOBAL", metric: "MAX_GROUPS"})()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce scoped MAX_TEMPLATES quota", async () => {
    // Given
    // 1. Create a space
    const space = await createMockSpaceInDb(prisma, {name: "Space 1"})
    // 2. Set quota for TEMPLATES in SPACE scope to 1
    // Note: Database no longer has targetId, so this applies to ALL spaces.
    await upsertQuotaHelper({scope: "SPACE", metric: "MAX_TEMPLATES"}, 1)
    // 3. Create one template in the space
    await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id, name: "Template 1"})

    // When
    // 4. Check quota for this space
    const result1 = await quotaService.isTargetedQuotaAvailable({scope: "SPACE", metric: "MAX_TEMPLATES"}, space.id)()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 5. Create another space and check quota there (should be 0 usage)
    const space2 = await createMockSpaceInDb(prisma, {name: "Space 2"})

    // When
    const result2 = await quotaService.isTargetedQuotaAvailable({scope: "SPACE", metric: "MAX_TEMPLATES"}, space2.id)()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce MAX_ROLES_PER_USER quota", async () => {
    // Given
    // 1. Create a user
    const user = await createDomainMockUserInDb(prisma, {email: "quota-user@example.com"})
    // 2. Set quota for ROLES per USER to 0 (effectively preventing any role assignment)
    await upsertQuotaHelper({scope: "USER", metric: "MAX_ROLES_PER_USER"}, 0)

    // When
    // 3. Check quota for this user (should be false as 1 > 0)
    // The check logic adds 1 to current roles to see if *another* role can be added
    const result1 = await quotaService.isTargetedQuotaAvailable(
      {scope: "USER", metric: "MAX_ROLES_PER_USER"},
      user.id
    )()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 4. Increase quota to 1
    await upsertQuotaHelper({scope: "USER", metric: "MAX_ROLES_PER_USER"}, 1)

    // When
    // 5. Check quota again (should be true as 1 <= 1)
    const result2 = await quotaService.isTargetedQuotaAvailable(
      {scope: "USER", metric: "MAX_ROLES_PER_USER"},
      user.id
    )()

    // Expect
    expect(result2).toBeRightOf(true)
  })

  it("should enforce MAX_ENTITIES_PER_GROUP quota", async () => {
    // Given
    // 1. Create a group
    const group = await createTestGroup(prisma, {name: "Group Entities"})
    // 2. Set quota for ENTITIES per GROUP to 1
    await upsertQuotaHelper({scope: "GROUP", metric: "MAX_ENTITIES_PER_GROUP"}, 1)
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
    const result1 = await quotaService.isTargetedQuotaAvailable(
      {scope: "GROUP", metric: "MAX_ENTITIES_PER_GROUP"},
      group.id
    )()

    // Expect
    expect(result1).toBeRightOf(false)

    // Given
    // 5. Increase quota to 2
    await upsertQuotaHelper({scope: "GROUP", metric: "MAX_ENTITIES_PER_GROUP"}, 2)

    // When
    // 6. Check quota (usage 1, limit 2 -> should pass)
    const result2 = await quotaService.isTargetedQuotaAvailable(
      {scope: "GROUP", metric: "MAX_ENTITIES_PER_GROUP"},
      group.id
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
    const result3 = await quotaService.isTargetedQuotaAvailable(
      {scope: "GROUP", metric: "MAX_ENTITIES_PER_GROUP"},
      group.id
    )()

    // Expect
    expect(result3).toBeRightOf(false)
  })
})
