import {QuotaCheckRequestFactory, QuotaRepository, QuotaService} from "@services"
import {Test, TestingModule} from "@nestjs/testing"
import {ServiceModule} from "@services/service.module"
import {ConfigModule} from "@external/config.module"
import {QUOTA_REPOSITORY_TOKEN} from "@services/quota/interfaces"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockSpaceInDb, createMockWorkflowTemplateInDb, createTestGroup} from "@test/mock-data"
import {ConfigProvider} from "@external/config"
import {PrismaClient} from "@prisma/client"
import {DatabaseClient} from "@external"
import {RATE_LIMITER_PROVIDER_TOKEN, RateLimiterProvider} from "@services/rate-limiter/rate-limiter.interface"
import * as TE from "fp-ts/lib/TaskEither"

describe("Quota Integration Tests", () => {
  let module: TestingModule
  let quotaService: QuotaService
  let quotaRepo: QuotaRepository
  let prisma: PrismaClient

  const mockRateLimiterProvider: RateLimiterProvider = {
    consume: () => TE.right({} as any)
  }

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()

    module = await Test.createTestingModule({
      imports: [ConfigModule, ServiceModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .overrideProvider(RATE_LIMITER_PROVIDER_TOKEN)
      .useValue(mockRateLimiterProvider)
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

  it("should enforce global MAX_GROUPS quota", async () => {
    // 1. Set global quota for groups to 1
    await quotaRepo.upsertQuota("GLOBAL", "MAX_GROUPS", 1)()

    // 2. Create one group
    await createTestGroup(prisma, {name: "Group 1"})

    // 3. Check quota - should be at limit (usage 1, limit 1 -> returns false as usage < limit is false)
    const result1 = await quotaService.checkQuota(QuotaCheckRequestFactory.create("MAX_GROUPS"))()
    expect(result1).toEqual(expect.objectContaining({_tag: "Right", right: false}))

    // 4. Increase quota to 2
    await quotaRepo.upsertQuota("GLOBAL", "MAX_GROUPS", 2)()

    const result2 = await quotaService.checkQuota(QuotaCheckRequestFactory.create("MAX_GROUPS"))()
    expect(result2).toEqual(expect.objectContaining({_tag: "Right", right: true}))
  })

  it("should enforce scoped MAX_TEMPLATES quota", async () => {
    // 1. Create a space
    const space = await createMockSpaceInDb(prisma, {name: "Space 1"})

    // 2. Set quota for TEMPLATES in SPACE scope to 1
    // Note: Database no longer has targetId, so this applies to ALL spaces.
    await quotaRepo.upsertQuota("SPACE", "MAX_TEMPLATES", 1)()

    // 3. Create one template in the space
    await createMockWorkflowTemplateInDb(prisma, {spaceId: space.id, name: "Template 1"})

    // 4. Check quota for this space
    const result1 = await quotaService.checkQuota(QuotaCheckRequestFactory.create("MAX_TEMPLATES", space.id))()

    expect(result1).toEqual(expect.objectContaining({_tag: "Right", right: false}))

    // 5. Create another space and check quota there (should be 0 usage)
    const space2 = await createMockSpaceInDb(prisma, {name: "Space 2"})
    const result2 = await quotaService.checkQuota(QuotaCheckRequestFactory.create("MAX_TEMPLATES", space2.id))()

    expect(result2).toEqual(expect.objectContaining({_tag: "Right", right: true}))
  })
})
