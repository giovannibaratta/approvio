import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, QuotaDbRepository} from "@external"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockQuotaInDb} from "@test/mock-data"
import {QuotaFactory, SupportedQuotaType} from "@domain"
import {DEFAULT_ORG_ID} from "@services"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("QuotaDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: QuotaDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotaDbRepository,
        DatabaseClient,
        {
          provide: ConfigProvider,
          useValue: MockConfigProvider.fromDbConnectionUrl(isolatedDb)
        }
      ]
    }).compile()

    prisma = module.get(DatabaseClient).prisma
    repository = module.get(QuotaDbRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("createQuota", () => {
    it("should return quota_already_exists when creating a duplicate quota", async () => {
      // Given
      const quota = unwrapRight(
        QuotaFactory.newQuota({node: {type: "Org", identifier: DEFAULT_ORG_ID}, quotaType: "MAX_GROUPS"}, 10)
      )

      await repository.createQuota(quota)()

      // When: creating a quota with a different ID but same (scope, quotaType, targetId)
      const duplicateQuota = {...quota, id: uuidv7()}
      const duplicateResult = await repository.createQuota(duplicateQuota)()

      // Expect
      expect(duplicateResult).toBeLeftOf("quota_already_exists")
    })
  })

  describe("listQuotas", () => {
    it("should provide deterministic ordering using id as secondary sort key", async () => {
      // Given: 5 quotas created at the exact same timestamp
      const now = new Date()
      const quotaTypes: SupportedQuotaType[] = [
        "MAX_GROUPS",
        "MAX_SPACES",
        "MAX_WORKFLOW_TEMPLATES_PER_SPACE",
        "MAX_CONCURRENT_WORKFLOWS",
        "MAX_VOTES_PER_WORKFLOW"
      ]
      const quotas = quotaTypes.map(quotaType =>
        unwrapRight(QuotaFactory.newQuota({node: {type: "Org", identifier: DEFAULT_ORG_ID}, quotaType}, 10))
      )

      for (const q of quotas) {
        await createMockQuotaInDb(prisma, {
          id: q.id,
          scope: q.node.type,
          quotaType: q.quotaType,
          limit: q.limit,
          targetId: q.node.identifier,
          createdAt: now,
          updatedAt: now
        })
      }

      // When: listing quotas
      const result = unwrapRight(await repository.listQuotas(1, 10)())

      // Expect: results should be sorted by id (desc) since createdAt is identical
      const ids = result.items.map(i => i.id)
      const sortedIds = [...ids].sort((a, b) => b.localeCompare(a))
      expect(ids).toEqual(sortedIds)
    })
  })
})
