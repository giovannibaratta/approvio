import {createMockOrganization} from "@test/mock-data"
import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {SpaceFactory} from "@domain"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {createDomainMockUserInDb} from "@test/mock-data"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {SpaceTenantClient} from "@external/database/tenant-database-clients"
import {SpaceDbRepository} from "@external/database/space.repository"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

// Direct persistence access lets this test supply a foreign user ID that the HTTP flow does not expose.
describe("SpaceDbRepository atomic permission boundaries", () => {
  let prisma: PrismaClient
  let module: TestingModule
  let repository: SpaceDbRepository
  let organizationA: ReturnType<typeof toOrganizationId>
  let organizationB: ReturnType<typeof toOrganizationId>

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    prisma = createFixturePrismaClient(connectionString)
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        SpaceTenantClient,
        SpaceDbRepository,
        PrismaTransactionManager,
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

    repository = module.get(SpaceDbRepository)

    await module.init()
    organizationA = randomOrgId()
    organizationB = randomOrgId()

    await Promise.all([
      prisma.organization.create({
        data: createMockOrganization({id: organizationA, displayName: `Organization ${organizationA}`})
      }),
      prisma.organization.create({
        data: createMockOrganization({id: organizationB, displayName: `Organization ${organizationB}`})
      })
    ])
  }, 30_000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  it("rejects foreign-user links and rolls back a create when the scoped user is absent", async () => {
    // Given
    const foreignUser = await createDomainMockUserInDb(prisma, {organizationId: organizationB})
    const space = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Attempted"}))
    const context = {organizationId: organizationA}
    const transactions = module.get(PrismaTransactionManager)
    const foreignBefore = await prisma.user.findUniqueOrThrow({where: {id: foreignUser.id}})

    // When: The space insert succeeds, but the tenant-scoped user update cannot find the foreign ID.
    const result = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space, user: foreignUser, userOcc: foreignBefore.occ})
    )()

    // Expect: A user outside this tenant is reported as missing, and the insert is rolled back.
    expect(result).toBeLeftOf("user_not_found")
    expect(await prisma.space.count({where: {id: space.id}})).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({where: {id: foreignUser.id}})).toEqual(foreignBefore)
  })

  it("reports stale user OCC as a concurrency error and rolls back space creation", async () => {
    // Given
    const user = await createDomainMockUserInDb(prisma, {organizationId: organizationA})
    const original = await prisma.user.findUniqueOrThrow({where: {id: user.id}})
    const before = await prisma.user.update({where: {id: user.id}, data: {occ: {increment: 1}}})
    const space = unwrapRight(SpaceFactory.newSpace({organizationId: organizationA, name: "Stale user"}))
    const context = {organizationId: organizationA}
    const transactions = module.get(PrismaTransactionManager)

    // When
    const result = await transactions.execute(context, () =>
      repository.createSpaceWithUserPermissions(context, {space, user, userOcc: original.occ})
    )()

    // Expect: The user exists in this tenant, so the missed update is an OCC conflict.
    expect(result).toBeLeftOf("concurrency_error")
    expect(await prisma.space.count({where: {id: space.id}})).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({where: {id: user.id}})).toEqual(before)
  })
})
