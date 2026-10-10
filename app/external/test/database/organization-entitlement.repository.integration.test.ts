import {randomOrgId} from "@test/organization-id"
import {DatabaseClient} from "@external/database/database-client"
import {OrganizationDirectoryTenantClient} from "@external/database/tenant-database-clients"
import {OrganizationEntitlementDbRepository} from "@external/database/organization-entitlement.repository"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {OrganizationEntitlementService} from "@services/tenancy/organization-entitlement.service"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import "@utils/matchers"

// The API binds both contexts; direct access is needed to test a mismatched transaction context.
describe("OrganizationEntitlementDbRepository RLS boundary", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: OrganizationEntitlementDbRepository

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    prisma = createFixturePrismaClient(connectionString)
    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    repository = new OrganizationEntitlementDbRepository(new OrganizationDirectoryTenantClient(database))
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("rejects a plan read for a different organization than the active transaction context", async () => {
    // Given
    const organizationA = randomOrgId()
    const organizationB = randomOrgId()
    await Promise.all([
      prisma.organization.create({data: organization(organizationA, "FREE")}),
      prisma.organization.create({data: organization(organizationB, "SELF_HOSTED_UNLIMITED")})
    ])

    // When
    const crossTenantRead = await database.transactional(organizationB, () =>
      repository.getPlanTier({organizationId: organizationA})()
    )

    // Expect
    expect(crossTenantRead).toBeLeftOf("organization_not_found")
  })

  it("returns a transaction error when the plan query fails in storage", async () => {
    // Given
    const organizationId = randomOrgId()
    await prisma.organization.create({data: organization(organizationId, "FREE")})
    const service = new OrganizationEntitlementService(repository, new PrismaTransactionManager(database))
    await prisma.$executeRaw`ALTER TABLE organizations RENAME COLUMN plan_tier TO unavailable_plan_tier`

    try {
      // When
      const result = await service.getPlanTier({organizationId})()

      // Expect
      expect(result).toBeLeftOf("storage_unavailable")
    } finally {
      await prisma.$executeRaw`ALTER TABLE organizations RENAME COLUMN unavailable_plan_tier TO plan_tier`
    }
  })
})

function organization(id: string, planTier: "FREE" | "SELF_HOSTED_UNLIMITED") {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: `Organization ${id}`,
    planTier,
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
