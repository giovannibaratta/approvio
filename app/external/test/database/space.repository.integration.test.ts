import {SpaceFactory, UserFactory} from "@domain"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {createDomainMockUserInDb} from "@test/mock-data"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {DatabaseClient} from "@external/database/database-client"
import {SpaceTenantClient} from "@external/database/tenant-database-clients"
import {SpaceDbRepository} from "@external/database/space.repository"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

// Forged user inputs and stale internal OCC require direct transactional persistence access.
describe("SpaceDbRepository atomic permission boundaries", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: SpaceDbRepository
  let organizationA: ReturnType<typeof toOrganizationId>
  let organizationB: ReturnType<typeof toOrganizationId>

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
    repository = new SpaceDbRepository(new SpaceTenantClient(database))
    organizationA = randomOrgId()
    organizationB = randomOrgId()
    await Promise.all([
      prisma.organization.create({data: organization(organizationA)}),
      prisma.organization.create({data: organization(organizationB)})
    ])
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("rejects foreign-user links and rolls back a create when the scoped user is absent", async () => {
    const foreignUser = await createDomainMockUserInDb(prisma, {organizationId: organizationB})
    const space = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Attempted"}))
    const context = {organizationId: organizationA}
    const transactions = new PrismaTransactionManager(database)
    const foreignBefore = await prisma.user.findUniqueOrThrow({where: {id: foreignUser.id}})

    const mismatchedLink = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space, user: foreignUser, userOcc: 0n})
    )()
    expect(mismatchedLink).toBeLeftOf("concurrency_error")

    // A forged organization on the input must not make a foreign user ID writable.
    // The space INSERT occurs first; the failed scoped user update must roll it back.
    const forgedUser = unwrapRight(UserFactory.validate({...foreignUser, organizationId: organizationA}))
    const missingScopedUser = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space, user: forgedUser, userOcc: foreignBefore.occ})
    )()
    expect(missingScopedUser).toBeLeftOf("concurrency_error")
    expect(await prisma.space.count({where: {id: space.id}})).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({where: {id: foreignUser.id}})).toEqual(foreignBefore)
  })

  it("commits local permission updates atomically and rolls back stale versions and duplicate names", async () => {
    const user = await createDomainMockUserInDb(prisma, {organizationId: organizationA})
    const context = {organizationId: organizationA}
    const transactions = new PrismaTransactionManager(database)
    const first = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Local"}))
    const initial = await prisma.user.findUniqueOrThrow({where: {id: user.id}})
    const changedUser = unwrapRight(UserFactory.validate({...user, displayName: "Updated member"}))
    const created = unwrapRight(
      await transactions.execute(context, () =>
        repository.createSpaceWithUserPermissions(context, {space: first, user: changedUser, userOcc: initial.occ})
      )()
    )
    expect(created.id).toBe(first.id)
    const committed = await prisma.user.findUniqueOrThrow({where: {id: user.id}})
    expect(committed.displayName).toBe("Updated member")
    expect(committed.occ).toBe(initial.occ + 1n)

    const staleSpace = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Stale"}))
    const stale = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space: staleSpace, user, userOcc: initial.occ})
    )()
    expect(stale).toBeLeftOf("concurrency_error")
    expect(await prisma.space.count({where: {id: staleSpace.id}})).toBe(0)

    const duplicateSpace = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Local"}))
    const duplicate = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space: duplicateSpace, user, userOcc: committed.occ})
    )()
    expect(duplicate).toBeLeftOf("space_already_exists")
    expect(await prisma.space.count({where: {organizationId: organizationA}})).toBe(1)
    expect(await prisma.user.findUniqueOrThrow({where: {id: user.id}})).toEqual(committed)
  })
})

function organization(id: string) {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: `Organization ${id}`,
    planTier: "FREE",
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
