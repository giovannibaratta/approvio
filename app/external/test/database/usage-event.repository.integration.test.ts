import {CreateUsageEvent, UsageEventFactory, UsageMetric} from "@domain"
import {ConfigModule, DatabaseClient, KmsModule, PostgresUsageEventRepository} from "@external"
import {ConfigProvider} from "@external/config"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, prepareDatabase} from "@test/database"
import {MockConfigProvider, createMockOrganization} from "@test/mock-data"
import {randomOrgId} from "@test/organization-id"
import {UsageEventTenantClient} from "@external/database/tenant-database-clients"
import {DATABASE_RUNTIME_ROLE_TOKEN} from "@external/database/database-client"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("PostgresUsageEventRepository Integration", () => {
  let prisma: PrismaClient
  let repository: PostgresUsageEventRepository
  let database: DatabaseClient
  let module: TestingModule
  let organizationId: ReturnType<typeof randomOrgId>

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    module = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [
        PostgresUsageEventRepository,
        DatabaseClient,
        UsageEventTenantClient,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"}
      ]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
      .compile()

    await module.init()
    database = module.get(DatabaseClient)
    prisma = createFixturePrismaClient(isolatedDb)
    organizationId = randomOrgId()
    await prisma.organization.create({data: createMockOrganization({id: organizationId})})
    repository = module.get(PostgresUsageEventRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await module.close()
  })

  describe("persist", () => {
    it("should persist a single usage event to the database", async () => {
      // Given
      const entityId = uuidv7()
      const actorId = uuidv7()
      const event: CreateUsageEvent = {
        organizationId,
        entityType: "WORKFLOW",
        entityId,
        actor: {
          id: actorId,
          type: "user",
          displayName: "User"
        },
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        quantity: 1250n,
        isBillable: true,
        occurredAt: new Date("2026-08-15T10:00:00.000Z"),
        metadata: {
          provider: "anthropic",
          model: "claude-3-7-sonnet"
        }
      }

      // When
      const result = await database.transactional({type: "organization", organizationId}, () =>
        repository.persist(unwrapRight(UsageEventFactory.create(event)))()
      )

      // Expect
      expect(result).toBeRight()

      const records = await prisma.usageEvent.findMany({where: {entityId}})
      expect(records).toHaveLength(1)
      const [record] = records
      expect(record).toMatchObject({
        entityType: "WORKFLOW",
        entityId,
        actorType: "user",
        actorId,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        quantity: 1250n,
        isBillable: true,
        occurredAt: new Date("2026-08-15T10:00:00.000Z"),
        metadata: {
          provider: "anthropic",
          model: "claude-3-7-sonnet"
        }
      })
    })
  })

  describe("persistBatch", () => {
    it("should persist multiple usage events in a batch", async () => {
      // Given
      const entityId1 = uuidv7()
      const entityId2 = uuidv7()
      const actorId = uuidv7()

      const events: CreateUsageEvent[] = [
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: entityId1,
          actor: {id: actorId, type: "agent", displayName: "Agent"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 1n,
          isBillable: true,
          occurredAt: new Date("2026-08-10T12:00:00.000Z")
        },
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: entityId2,
          actor: {id: actorId, type: "agent", displayName: "Agent"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 2n,
          isBillable: true,
          occurredAt: new Date("2026-08-11T14:00:00.000Z")
        }
      ]

      // When
      const result = await database.transactional({type: "organization", organizationId}, () =>
        repository.persistBatch(events.map(event => unwrapRight(UsageEventFactory.create(event))))()
      )

      // Expect
      expect(result).toBeRight()

      const records = await prisma.usageEvent.findMany({
        where: {actorId},
        orderBy: {occurredAt: "asc"}
      })
      expect(records).toHaveLength(2)
      const [first, second] = records
      expect(first?.entityId).toBe(entityId1)
      expect(first?.quantity).toBe(1n)
      expect(second?.entityId).toBe(entityId2)
      expect(second?.quantity).toBe(2n)
    })

    it("should succeed without error when batch is empty", async () => {
      // Given
      const events: CreateUsageEvent[] = []

      // When
      const result = await database.transactional({type: "organization", organizationId}, () =>
        repository.persistBatch(events.map(event => unwrapRight(UsageEventFactory.create(event))))()
      )

      // Expect
      expect(result).toBeRight()
    })
  })

  describe("getPeriodTotal", () => {
    it("should aggregate total quantity for metric within the date range", async () => {
      // Given
      const metric: UsageMetric = "MAX_LLM_TOKENS_PER_MONTH"
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      const events: CreateUsageEvent[] = [
        // Within range
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user", displayName: "User"},
          metric,
          quantity: 500n,
          isBillable: true,
          occurredAt: new Date("2026-08-05T10:00:00.000Z")
        },
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "agent", displayName: "Agent"},
          metric,
          quantity: 1500n,
          isBillable: true,
          occurredAt: new Date("2026-08-20T15:30:00.000Z")
        },
        // Outside range (earlier)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user", displayName: "User"},
          metric,
          quantity: 9999n,
          isBillable: true,
          occurredAt: new Date("2026-07-31T23:59:59.000Z")
        },
        // Outside range (later)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user", displayName: "User"},
          metric,
          quantity: 8888n,
          isBillable: true,
          occurredAt: new Date("2026-09-01T00:00:01.000Z")
        },
        // Different metric (within range)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user", displayName: "User"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 10n,
          isBillable: true,
          occurredAt: new Date("2026-08-15T12:00:00.000Z")
        }
      ]

      await database.transactional({type: "organization", organizationId}, () =>
        repository.persistBatch(events.map(event => unwrapRight(UsageEventFactory.create(event))))()
      )

      // When
      const totalResult = await database.transactional({type: "organization", organizationId}, () =>
        repository.getPeriodTotal({organizationId}, metric, fromDate, toDate)()
      )

      // Expect: 500 + 1500 = 2000
      const total = unwrapRight(totalResult)
      expect(total).toBe(2000n)
    })

    it("should return 0n when no events exist in period", async () => {
      // Given
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      // When
      const totalResult = await database.transactional({type: "organization", organizationId}, () =>
        repository.getPeriodTotal({organizationId}, "MAX_LLM_TOKENS_PER_MONTH", fromDate, toDate)()
      )

      // Expect
      const total = unwrapRight(totalResult)
      expect(total).toBe(0n)
    })
  })

  describe("getActorBreakdown", () => {
    it("should aggregate usage grouped by actor within date range", async () => {
      // Given
      const metric: UsageMetric = "MAX_LLM_TOKENS_PER_MONTH"
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      const userActorId = uuidv7()
      const agentActorId = uuidv7()

      const events: CreateUsageEvent[] = [
        // User actor: 2 events (300 + 700 = 1000)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user", displayName: "User"},
          metric,
          quantity: 300n,
          isBillable: true,
          occurredAt: new Date("2026-08-05T10:00:00.000Z")
        },
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user", displayName: "User"},
          metric,
          quantity: 700n,
          isBillable: true,
          occurredAt: new Date("2026-08-10T11:00:00.000Z")
        },
        // Agent actor: 1 event (2500)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: agentActorId, type: "agent", displayName: "Agent"},
          metric,
          quantity: 2500n,
          isBillable: true,
          occurredAt: new Date("2026-08-15T12:00:00.000Z")
        },
        // Out of range (should be excluded)
        {
          organizationId,
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user", displayName: "User"},
          metric,
          quantity: 9999n,
          isBillable: true,
          occurredAt: new Date("2026-09-05T10:00:00.000Z")
        }
      ]

      await database.transactional({type: "organization", organizationId}, () =>
        repository.persistBatch(events.map(event => unwrapRight(UsageEventFactory.create(event))))()
      )

      // When
      const breakdownResult = await database.transactional({type: "organization", organizationId}, () =>
        repository.getActorBreakdown({organizationId}, metric, fromDate, toDate)()
      )

      // Expect
      const breakdown = unwrapRight(breakdownResult)
      expect(breakdown).toHaveLength(2)

      const userSummary = breakdown.find(b => b.actor.id === userActorId)
      expect(userSummary).toEqual({
        actor: {id: userActorId, type: "user", displayName: "User"},
        totalQuantity: 1000n
      })

      const agentSummary = breakdown.find(b => b.actor.id === agentActorId)
      expect(agentSummary).toEqual({
        actor: {id: agentActorId, type: "agent", displayName: "Agent"},
        totalQuantity: 2500n
      })
    })

    it("should return empty array when no events exist in period", async () => {
      // Given
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      // When
      const breakdownResult = await database.transactional({type: "organization", organizationId}, () =>
        repository.getActorBreakdown({organizationId}, "MAX_CREDITS_PER_MONTH", fromDate, toDate)()
      )

      // Expect
      const breakdown = unwrapRight(breakdownResult)
      expect(breakdown).toEqual([])
    })
  })
})
