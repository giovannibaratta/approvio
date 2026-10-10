import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {CreateUsageEvent} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {UsageEventTenantClient} from "@external/database/tenant-database-clients"
import {PostgresUsageEventRepository} from "@external/database/usage-event.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

describe("PostgresUsageEventRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: PostgresUsageEventRepository
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
    repository = new PostgresUsageEventRepository(new UsageEventTenantClient(database))
    organizationId = randomOrgId()
    await prisma.organization.create({data: organization(organizationId)})
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("persists immutable actor snapshots and aggregates within one organization", async () => {
    const context = {organizationId}
    const userId = uuidv7()
    const agentId = uuidv7()
    const events = [
      event(organizationId, userId, "user", "Ada", 300n, new Date("2026-08-05T10:00:00.000Z")),
      event(organizationId, userId, "user", "Ada", 700n, new Date("2026-08-10T10:00:00.000Z")),
      event(organizationId, agentId, "agent", "Runner", 2500n, new Date("2026-08-15T10:00:00.000Z"))
    ]
    unwrapRight(await database.transactional(organizationId, () => repository.persistBatch(context, events)()))

    const from = new Date("2026-08-01T00:00:00.000Z")
    const to = new Date("2026-08-31T23:59:59.999Z")
    const total = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.getPeriodTotal(context, "MAX_LLM_TOKENS_PER_MONTH", from, to)()
      )
    )
    expect(total).toBe(3500n)
    const breakdown = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.getActorBreakdown(context, "MAX_LLM_TOKENS_PER_MONTH", from, to)()
      )
    )
    expect(breakdown).toEqual(
      expect.arrayContaining([
        {actor: {id: userId, type: "user", displayName: "Ada"}, totalQuantity: 1000n},
        {actor: {id: agentId, type: "agent", displayName: "Runner"}, totalQuantity: 2500n}
      ])
    )

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = await database.transactional(otherOrganizationId, () =>
      repository.getPeriodTotal({organizationId: otherOrganizationId}, "MAX_LLM_TOKENS_PER_MONTH", from, to)()
    )
    expect(unwrapRight(foreign)).toBe(0n)
  })
})

function event(
  organizationId: string,
  actorId: string,
  actorType: "user" | "agent",
  displayName: string,
  quantity: bigint,
  occurredAt: Date
): CreateUsageEvent {
  return {
    organizationId: toOrganizationId(organizationId),
    entityType: "WORKFLOW",
    entityId: uuidv7(),
    actor: {id: actorId, type: actorType, displayName},
    metric: "MAX_LLM_TOKENS_PER_MONTH",
    quantity,
    isBillable: true,
    occurredAt,
    metadata: {source: "integration-test"}
  }
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
