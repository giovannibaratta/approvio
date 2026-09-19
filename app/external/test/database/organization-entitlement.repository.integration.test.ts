import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {randomOrgId} from "@test/organization-id"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {OrganizationDirectoryTenantClient} from "@external/database/tenant-database-clients"
import {OrganizationEntitlementDbRepository} from "@external/database/organization-entitlement.repository"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import {ensureTestOrganization} from "@test/mock-data"
import "@utils/matchers"

// The API binds both contexts; direct access is needed to test a mismatched transaction context.
describe("OrganizationEntitlementDbRepository RLS boundary", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let database: DatabaseClient
  let repository: OrganizationEntitlementDbRepository

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    prisma = createFixturePrismaClient(connectionString)
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        OrganizationDirectoryTenantClient,
        OrganizationEntitlementDbRepository,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"},
        {
          provide: ConfigProvider,
          useValue: {
            databaseConfig: {
              tenantConnectionUrl: connectionString,
              platformConnectionUrl: connectionString,
              retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
            }
          }
        }
      ]
    }).compile()
    database = module.get(DatabaseClient)
    repository = module.get(OrganizationEntitlementDbRepository)
    await module.init()
  }, 30_000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  it("rejects a plan read for a different organization than the active transaction context", async () => {
    // Given
    const organizationA = randomOrgId()
    const organizationB = randomOrgId()
    await Promise.all([
      ensureTestOrganization(prisma, organizationA, "FREE"),
      ensureTestOrganization(prisma, organizationB, "SELF_HOSTED_UNLIMITED")
    ])

    // When
    const crossTenantRead = await database.transactional({type: "organization", organizationId: organizationB}, () =>
      repository.getPlanTier({organizationId: organizationA})()
    )

    // Expect
    expect(crossTenantRead).toBeLeftOf("organization_not_found")
  })
})
