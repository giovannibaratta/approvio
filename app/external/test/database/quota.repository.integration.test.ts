import {createMockOrganization} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, QuotaDbRepository, KmsModule, ConfigModule} from "@external"
import {DATABASE_RUNTIME_ROLE_TOKEN} from "@external/database/database-client"
import {QuotaTenantClient} from "@external/database/tenant-database-clients"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockQuotaInDb} from "@test/mock-data"
import {QuotaFactory, SupportedQuotaType} from "@domain"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("QuotaDbRepository Integration", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let database: DatabaseClient
  let repository: QuotaDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [
        QuotaDbRepository,
        DatabaseClient,
        QuotaTenantClient,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: isolatedDb,
          databaseRetry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
        })
      )
      .compile()
    database = module.get(DatabaseClient)
    repository = module.get(QuotaDbRepository)
    await module.init()
    prisma = createFixturePrismaClient(isolatedDb)
    organizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: organizationId})})
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  describe("createQuota", () => {
    it("should return quota_already_exists when creating a duplicate quota", async () => {
      // Given
      const quota = unwrapRight(
        QuotaFactory.newQuota(
          {organizationId, node: {type: "Org", identifier: organizationId}, quotaType: "MAX_GROUPS"},
          10n
        )
      )

      unwrapRight(
        await database.transactional({type: "organization", organizationId}, () =>
          repository.createQuota({organizationId}, quota)()
        )
      )

      // When: creating a quota with a different ID but same (scope, quotaType, targetId)
      const duplicateQuota = {...quota, id: uuidv7()}
      const duplicateResult = await database.transactional({type: "organization", organizationId}, () =>
        repository.createQuota({organizationId}, duplicateQuota)()
      )

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
        unwrapRight(
          QuotaFactory.newQuota({organizationId, node: {type: "Org", identifier: organizationId}, quotaType}, 10n)
        )
      )

      for (const q of quotas)
        await createMockQuotaInDb(prisma, {
          organizationId,
          id: q.id,
          scope: q.node.type,
          quotaType: q.quotaType,
          limit: q.limit,
          targetId: q.node.identifier,
          createdAt: now,
          updatedAt: now
        })

      // When: listing quotas
      const result = unwrapRight(await repository.listQuotas({organizationId}, 1, 10)())

      // Expect: results should be sorted by id (desc) since createdAt is identical
      const ids = result.items.map(i => i.id)
      const sortedIds = [...ids].sort((a, b) => b.localeCompare(a))
      expect(ids).toEqual(sortedIds)
    })
  })

  describe("getQuotaById", () => {
    it("should not retrieve another organization's quota", async () => {
      // Given
      const quota = await createMockQuotaInDb(prisma, {organizationId})
      const otherOrganizationId = randomOrgId()
      await prisma.organization.create({data: createMockOrganization({id: otherOrganizationId})})

      // When
      const result = await database.transactional({type: "organization", organizationId: otherOrganizationId}, () =>
        repository.getQuotaById({organizationId: otherOrganizationId}, quota.id)()
      )

      // Expect
      expect(result).toBeLeftOf("quota_not_found")
    })
  })
})
