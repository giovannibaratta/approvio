import {randomOrgId} from "@test/organization-id"
import {PlatformSecurityDatabaseClient} from "@external/database/capability-database-client"
import {DatabaseClient} from "@external/database/database-client"
import {PlatformSecurityEventDbRepository} from "@external/database/platform-security-event.repository"
import {PlatformSecurityEventFactory} from "@domain"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("PlatformSecurityEventDbRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let security: PlatformSecurityDatabaseClient
  let repository: PlatformSecurityEventDbRepository

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
    security = new PlatformSecurityDatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    repository = new PlatformSecurityEventDbRepository(security)
    await security.onModuleInit()
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await security.onModuleDestroy()
    await database.onModuleDestroy()
  })

  it("writes append-only platform events through the dedicated platform capability", async () => {
    const id = uuidv7()
    const event = unwrapRight(
      PlatformSecurityEventFactory.validate({
        id,
        type: "organization.owner_restored",
        actor: {type: "operator", id: uuidv7(), displayName: "Support operator"},
        organizationId: randomOrgId(),
        accountId: uuidv7(),
        reason: "step_up_denied",
        occurredAt: new Date()
      })
    )
    unwrapRight(await repository.append(event)())

    const stored = await prisma.platformSecurityEvent.findUnique({where: {id}})
    expect(stored).toMatchObject({
      id,
      eventType: "organization.owner_restored",
      actorType: "operator",
      reason: "step_up_denied"
    })
    expect(stored?.metadata).toEqual({organizationId: expect.any(String), accountId: expect.any(String)})
  })
})
