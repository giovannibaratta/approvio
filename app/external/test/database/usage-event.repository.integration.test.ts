import {CreateUsageEvent, UsageMetric} from "@domain"
import {ConfigModule, DatabaseClient, KmsModule, PostgresUsageEventRepository} from "@external"
import {ConfigProvider} from "@external/config"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("PostgresUsageEventRepository Integration", () => {
  let prisma: PrismaClient
  let repository: PostgresUsageEventRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule, KmsModule],
      providers: [PostgresUsageEventRepository, DatabaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
      .compile()

    await module.init()
    prisma = module.get(DatabaseClient).prisma
    repository = module.get(PostgresUsageEventRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("persist", () => {
    it("should persist a single usage event to the database", async () => {
      // Given
      const entityId = uuidv7()
      const actorId = uuidv7()
      const event: CreateUsageEvent = {
        entityType: "WORKFLOW",
        entityId,
        actor: {
          id: actorId,
          type: "user"
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
      const result = await repository.persist(event)()

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
          entityType: "WORKFLOW",
          entityId: entityId1,
          actor: {id: actorId, type: "agent"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 1n,
          isBillable: true,
          occurredAt: new Date("2026-08-10T12:00:00.000Z")
        },
        {
          entityType: "WORKFLOW",
          entityId: entityId2,
          actor: {id: actorId, type: "agent"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 2n,
          isBillable: true,
          occurredAt: new Date("2026-08-11T14:00:00.000Z")
        }
      ]

      // When
      const result = await repository.persistBatch(events)()

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
      const result = await repository.persistBatch(events)()

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
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user"},
          metric,
          quantity: 500n,
          isBillable: true,
          occurredAt: new Date("2026-08-05T10:00:00.000Z")
        },
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "agent"},
          metric,
          quantity: 1500n,
          isBillable: true,
          occurredAt: new Date("2026-08-20T15:30:00.000Z")
        },
        // Outside range (earlier)
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user"},
          metric,
          quantity: 9999n,
          isBillable: true,
          occurredAt: new Date("2026-07-31T23:59:59.000Z")
        },
        // Outside range (later)
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user"},
          metric,
          quantity: 8888n,
          isBillable: true,
          occurredAt: new Date("2026-09-01T00:00:01.000Z")
        },
        // Different metric (within range)
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: uuidv7(), type: "user"},
          metric: "MAX_EVALUATIONS_PER_MONTH",
          quantity: 10n,
          isBillable: true,
          occurredAt: new Date("2026-08-15T12:00:00.000Z")
        }
      ]

      await repository.persistBatch(events)()

      // When
      const totalResult = await repository.getPeriodTotal(metric, fromDate, toDate)()

      // Expect: 500 + 1500 = 2000
      const total = unwrapRight(totalResult)
      expect(total).toBe(2000n)
    })

    it("should return 0n when no events exist in period", async () => {
      // Given
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      // When
      const totalResult = await repository.getPeriodTotal("MAX_LLM_TOKENS_PER_MONTH", fromDate, toDate)()

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
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user"},
          metric,
          quantity: 300n,
          isBillable: true,
          occurredAt: new Date("2026-08-05T10:00:00.000Z")
        },
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user"},
          metric,
          quantity: 700n,
          isBillable: true,
          occurredAt: new Date("2026-08-10T11:00:00.000Z")
        },
        // Agent actor: 1 event (2500)
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: agentActorId, type: "agent"},
          metric,
          quantity: 2500n,
          isBillable: true,
          occurredAt: new Date("2026-08-15T12:00:00.000Z")
        },
        // Out of range (should be excluded)
        {
          entityType: "WORKFLOW",
          entityId: uuidv7(),
          actor: {id: userActorId, type: "user"},
          metric,
          quantity: 9999n,
          isBillable: true,
          occurredAt: new Date("2026-09-05T10:00:00.000Z")
        }
      ]

      await repository.persistBatch(events)()

      // When
      const breakdownResult = await repository.getActorBreakdown(metric, fromDate, toDate)()

      // Expect
      const breakdown = unwrapRight(breakdownResult)
      expect(breakdown).toHaveLength(2)

      const userSummary = breakdown.find(b => b.actor.id === userActorId)
      expect(userSummary).toEqual({
        actor: {id: userActorId, type: "user"},
        totalQuantity: 1000n
      })

      const agentSummary = breakdown.find(b => b.actor.id === agentActorId)
      expect(agentSummary).toEqual({
        actor: {id: agentActorId, type: "agent"},
        totalQuantity: 2500n
      })
    })

    it("should return empty array when no events exist in period", async () => {
      // Given
      const fromDate = new Date("2026-08-01T00:00:00.000Z")
      const toDate = new Date("2026-08-31T23:59:59.999Z")

      // When
      const breakdownResult = await repository.getActorBreakdown("MAX_CREDITS_PER_MONTH", fromDate, toDate)()

      // Expect
      const breakdown = unwrapRight(breakdownResult)
      expect(breakdown).toEqual([])
    })
  })
})
