import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {OrgRole} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
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
  let database: DatabaseClient
  let repository: UserDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>
  let accountId: string

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(connectionString)
    repository = new UserDbRepository(new UserTenantClient(database))
    organizationId = randomOrgId()
    accountId = uuidv7()
    await prisma.organization.create({data: organization(organizationId)})
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
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("persists a local membership without an email identity and rejects foreign reads", async () => {
    const context = {organizationId}
    const user = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Local member", orgRole: OrgRole.MEMBER})
    )
    unwrapRight(await database.transactional(organizationId, () => repository.createUser(context, user)()))
    const found = unwrapRight(
      await database.transactional(organizationId, () => repository.getUserById(context, user.id)())
    )
    expect(found).toMatchObject({id: user.id, accountId, organizationId, displayName: "Local member", occ: 0n})

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = await database.transactional(otherOrganizationId, () =>
      repository.getUserById({organizationId: otherOrganizationId}, user.id)()
    )
    expect(foreign).toBeLeftOf("user_not_found")
  })
})

function organization(id: string) {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: "Test organization",
    planTier: "FREE",
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
