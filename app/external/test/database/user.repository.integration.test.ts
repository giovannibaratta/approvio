import {createMockOrganization} from "@test/mock-data"
import {ConfigModule, KmsModule} from "@external"
import {MockConfigProvider} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {OrgRole} from "@domain"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {UserTenantClient} from "@external/database/tenant-database-clients"
import {UserDbRepository} from "@external/database/user.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {createTestUser} from "@test/user"

describe("UserDbRepository integration", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let database: DatabaseClient
  let repository: UserDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>
  let accountId: string

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [
        UserDbRepository,
        DatabaseClient,
        UserTenantClient,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: connectionString,
          databaseRetry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
        })
      )
      .compile()
    database = module.get(DatabaseClient)
    repository = module.get(UserDbRepository)
    await module.init()
    prisma = createFixturePrismaClient(connectionString)
    organizationId = randomOrgId()
    accountId = uuidv7()
    await prisma.organization.create({data: createMockOrganization({id: organizationId})})
    await prisma.platformAccount.create({
      data: {
        id: accountId,
        displayName: "Account",
        profileEmail: "account@example.com",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        occ: 0n
      }
    })
  }, 30_000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  it("does not expose a user to another organization", async () => {
    // Given
    const user = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Local member", orgRole: OrgRole.MEMBER})
    )
    unwrapRight(
      await database.transactional({type: "organization", organizationId}, () => repository.createUser(user)())
    )
    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: otherOrganizationId})})

    // When
    const foreign = await database.transactional({type: "organization", organizationId: otherOrganizationId}, () =>
      repository.getUserById({organizationId: otherOrganizationId}, user.id)()
    )

    // Expect
    expect(foreign).toBeLeftOf("user_not_found")
  })
})
