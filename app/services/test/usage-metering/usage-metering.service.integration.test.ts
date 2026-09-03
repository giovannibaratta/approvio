import {OrgRole, PlanTier, UsageEntity, UsageMetric, UserFactory} from "@domain"
import {DatabaseClient, RedisClient} from "@external"
import {ConfigProvider} from "@external/config"
import {ConfigModule} from "@external/config.module"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {DEFAULT_ORG_ID} from "@services"
import {ServiceModule} from "@services/service.module"
import {
  AdmitAndReserveParams,
  CancelReservationParams,
  SettleUsageParams,
  UsageMeteringService
} from "@services/usage-metering"
import {cleanDatabase, cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("UsageMeteringService Integration Tests", () => {
  let module: TestingModule
  let service: UsageMeteringService
  let prisma: PrismaClient
  let redisClient: RedisClient
  let redisPrefix: string
  let isolatedDb: string

  const orgId = DEFAULT_ORG_ID
  const actor = {
    type: "user" as const,
    id: uuidv7()
  }
  const entity: UsageEntity = {
    type: "Workflow",
    id: uuidv7()
  }
  const period = "2026-08"

  const adminUser = unwrapRight(
    UserFactory.newUser({
      email: "admin@approvio.test",
      displayName: "Admin",
      orgRole: OrgRole.ADMIN
    })
  )
  const memberUser = unwrapRight(
    UserFactory.newUser({
      email: "member@approvio.test",
      displayName: "Member",
      orgRole: OrgRole.MEMBER
    })
  )

  const adminRequestor = {
    entityType: "user" as const,
    providerId: "test",
    user: {...adminUser, occ: 1n}
  }
  const memberRequestor = {
    entityType: "user" as const,
    providerId: "test",
    user: {...memberUser, occ: 1n}
  }

  const createModuleWithTier = async (planTier: PlanTier): Promise<TestingModule> => {
    const testModule = await Test.createTestingModule({
      imports: [ConfigModule, ServiceModule]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          dbConnectionUrl: isolatedDb,
          redisPrefix,
          planTier
        })
      )
      .compile()

    await testModule.init()
    return testModule
  }

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    module = await createModuleWithTier("SELF_HOSTED_UNLIMITED")
    service = module.get<UsageMeteringService>(UsageMeteringService)
    prisma = module.get(DatabaseClient).prisma
    redisClient = module.get(RedisClient)
  }, 30000)

  afterAll(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    redisClient.disconnect()
    await module.close()
  })

  beforeEach(async () => {
    await cleanDatabase(prisma)
    await cleanRedisByPrefix(redisPrefix)
  })

  describe("admitAndReserve", () => {
    it("should successfully admit and reserve capacity in UNLIMITED tier", async () => {
      // Given: SELF_HOSTED_UNLIMITED tier
      const params: AdmitAndReserveParams = {
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 2500,
        period
      }

      // When
      const result = await service.admitAndReserve(params)()

      // Expect
      expect(result).toBeRight()

      // Verify in Redis
      const usage = await service.getOrganizationUsage(adminRequestor, orgId, period, "MAX_LLM_TOKENS_PER_MONTH")()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.limit).toBe("UNLIMITED")
      expect(firstMetric?.reserved).toBe(2500)
      expect(firstMetric?.consumed).toBe(0)
      expect(firstMetric?.remaining).toBe("UNLIMITED")
    })

    it("should reject reservation when estimated units exceed FREE tier limit", async () => {
      // Given: FREE tier has limit 0 for metered tokens
      const freeTierModule = await createModuleWithTier("FREE")
      const freeTierService = freeTierModule.get<UsageMeteringService>(UsageMeteringService)
      const freeTierRedis = freeTierModule.get(RedisClient)

      const exceedingReservation: AdmitAndReserveParams = {
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100,
        period
      }

      // When
      const result = await freeTierService.admitAndReserve(exceedingReservation)()

      // Expect
      expect(result).toBeLeftOf("quota_exceeded")

      freeTierRedis.disconnect()
      await freeTierModule.close()
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: AdmitAndReserveParams = {
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100,
        period: "invalid-date"
      }

      // When
      const result = await service.admitAndReserve(params)()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_format")
    })
  })

  describe("settleUsage", () => {
    it("should atomically settle reservation in Redis and write immutable event to PostgreSQL", async () => {
      // Given: First reserve 2000 units
      const metric: UsageMetric = "MAX_EVALUATIONS_PER_MONTH"
      await service.admitAndReserve({
        orgId,
        entity,
        actor,
        metric,
        estimatedUnits: 2000,
        period
      })()

      const settleParams: SettleUsageParams = {
        orgId,
        entity,
        actor,
        metric,
        estimatedUnits: 2000,
        actualUnits: 1800,
        period,
        isBillable: true,
        metadata: {workflowExecutionId: "exec-123"}
      }

      // When
      const result = await service.settleUsage(settleParams)()

      // Expect
      expect(result).toBeRight()

      // 1. Verify Redis balances: reservation released, actual consumed recorded
      const usage = await service.getOrganizationUsage(adminRequestor, orgId, period, metric)()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.reserved).toBe(0)
      expect(firstMetric?.consumed).toBe(1800)

      // 2. Verify durable PostgreSQL ledger entry
      const persistedEvents = await prisma.usageEvent.findMany({
        where: {entityId: entity.id}
      })
      expect(persistedEvents).toHaveLength(1)
      const firstEvent = persistedEvents[0]
      expect(firstEvent).toMatchObject({
        entityType: entity.type,
        entityId: entity.id,
        actorType: actor.type,
        actorId: actor.id,
        metric,
        quantity: BigInt(1800),
        isBillable: true
      })
      expect(firstEvent?.metadata).toEqual({workflowExecutionId: "exec-123"})
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: SettleUsageParams = {
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100,
        actualUnits: 100,
        period: "2026-13"
      }

      // When
      const result = await service.settleUsage(params)()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_month")
    })
  })

  describe("cancelReservation", () => {
    it("should release reserved capacity hold from Redis", async () => {
      // Given: Reserve 1500 units
      const metric: UsageMetric = "MAX_CREDITS_PER_MONTH"
      await service.admitAndReserve({
        orgId,
        entity,
        actor,
        metric,
        estimatedUnits: 1500,
        period
      })()

      const cancelParams: CancelReservationParams = {
        orgId,
        metric,
        estimatedUnits: 1500,
        period
      }

      // When
      const result = await service.cancelReservation(cancelParams)()

      // Expect
      expect(result).toBeRight()

      // Verify in Redis
      const usage = await service.getOrganizationUsage(adminRequestor, orgId, period, metric)()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.reserved).toBe(0)
      expect(firstMetric?.consumed).toBe(0)
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: CancelReservationParams = {
        orgId,
        metric: "MAX_CREDITS_PER_MONTH",
        estimatedUnits: 100,
        period: "2026-99"
      }

      // When
      const result = await service.cancelReservation(params)()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_month")
    })
  })

  describe("getOrganizationUsage", () => {
    it("should retrieve organization usage across all metrics with date boundaries and units", async () => {
      // Given: Consume some tokens
      await service.admitAndReserve({
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000,
        period
      })()
      await service.settleUsage({
        orgId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000,
        actualUnits: 3000,
        period
      })()

      // When
      const result = await service.getOrganizationUsage(adminRequestor, orgId, period)()

      // Expect
      expect(result).toBeRight()
      const summary = unwrapRight(result)
      expect(summary.orgId).toBe(orgId)
      expect(summary.period).toBe(period)
      expect(summary.periodStartsAt).toEqual(new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 0)))
      expect(summary.periodEndsAt).toEqual(new Date(Date.UTC(2026, 7, 31, 23, 59, 59, 999)))

      const tokenMetric = summary.metrics.find(m => m.metric === "MAX_LLM_TOKENS_PER_MONTH")
      expect(tokenMetric).toBeDefined()
      expect(tokenMetric?.consumed).toBe(3000)
      expect(tokenMetric?.unit).toBe("tokens")
      expect(tokenMetric?.limit).toBe("UNLIMITED")
      expect(tokenMetric?.remaining).toBe("UNLIMITED")

      const evalMetric = summary.metrics.find(m => m.metric === "MAX_EVALUATIONS_PER_MONTH")
      expect(evalMetric).toBeDefined()
      expect(evalMetric?.consumed).toBe(0)
      expect(evalMetric?.unit).toBe("evaluations")
    })

    it("should return billing_period_invalid_format on malformed period strings", async () => {
      // When
      const result = await service.getOrganizationUsage(adminRequestor, orgId, "invalid-period")()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_format")
    })

    it("should return requestor_not_authorized when caller is not an Org Admin", async () => {
      // When
      const result = await service.getOrganizationUsage(memberRequestor, orgId, period)()

      // Expect
      expect(result).toBeLeftOf("requestor_not_authorized")
    })
  })
})
