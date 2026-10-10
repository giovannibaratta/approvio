import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {QuotaFactory} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {QuotaTenantClient} from "@external/database/tenant-database-clients"
import {QuotaDbRepository} from "@external/database/quota.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("QuotaDbRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: QuotaDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>

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
    repository = new QuotaDbRepository(new QuotaTenantClient(database))
    organizationId = randomOrgId()
    await prisma.organization.create({data: organization(organizationId)})
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("uses tenant-qualified uniqueness and deterministic pagination", async () => {
    const context = {organizationId}
    const first = quota(organizationId, "MAX_GROUPS")
    unwrapRight(await database.transactional(organizationId, () => repository.createQuota(context, first)()))

    const duplicate = {...first, id: uuidv7()}
    const duplicateResult = await database.transactional(organizationId, () =>
      repository.createQuota(context, duplicate)()
    )
    expect(duplicateResult).toBeLeftOf("quota_already_exists")

    const second = quota(organizationId, "MAX_SPACES")
    await database.transactional(organizationId, () => repository.createQuota(context, second)())
    const listed = unwrapRight(await repository.listQuotas(context, 1, 10)())
    expect(listed.items.map(item => item.id)).toEqual(
      [second.id, first.id].sort((left, right) => right.localeCompare(left))
    )

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = await database.transactional(otherOrganizationId, () =>
      repository.getQuotaById({organizationId: otherOrganizationId}, first.id)()
    )
    expect(foreign).toBeLeftOf("quota_not_found")
  })
})

function quota(organizationId: string, quotaType: "MAX_GROUPS" | "MAX_SPACES") {
  return unwrapRight(
    QuotaFactory.newQuota({organizationId, node: {type: "Org", identifier: organizationId}, quotaType}, 10)
  )
}

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
