import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {ALL_METERED_METRICS, OrgRole, UsageEntity, UsageMetric} from "@domain"
import {RedisClient} from "@external"
import {ConfigProvider} from "@external/config"
import {ConfigModule} from "@external/config.module"
import {Test, TestingModule} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {ServiceModule} from "@services/service.module"
import {QueueService} from "@services/queue"
import {
  AdmitAndReserveParams,
  QUOTA_ADMISSION_CLIENT_TOKEN,
  QuotaAdmissionClient,
  CancelReservationParams,
  SettleUsageParams,
  UsageMeteringService,
  UsageEventRepository,
  USAGE_EVENT_REPOSITORY_TOKEN
} from "@services/usage-metering"
import {
  createFixturePrismaClient,
  cleanDatabase,
  cleanRedisByPrefix,
  prepareDatabase,
  prepareRedisPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {USAGE_OPERATION_REPOSITORY_TOKEN, UsageOperationRepository} from "@services/durable-work/interfaces"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"
import {createTestUser} from "@test/user"

describe("UsageMeteringService Integration Tests", () => {
  let module: TestingModule
  let service: UsageMeteringService
  let prisma: PrismaClient
  let redisClient: RedisClient
  let redisPrefix: string
  let isolatedDb: string

  const orgId = randomOrgId()
  const actor = {
    type: "user" as const,
    id: uuidv7(),
    displayName: "Usage Test User"
  }
  const entity: UsageEntity = {
    type: "Workflow",
    id: uuidv7()
  }
  const period = "2026-08"
  const operationId = uuidv7()

  const adminUser = unwrapRight(
    createTestUser({
      organizationId: orgId,
      accountId: uuidv7(),
      displayName: "Admin",
      orgRole: OrgRole.ADMIN
    })
  )
  const memberUser = unwrapRight(
    createTestUser({
      organizationId: orgId,
      accountId: uuidv7(),
      displayName: "Member",
      orgRole: OrgRole.MEMBER
    })
  )

  const adminRequestor = {
    entityType: "user" as const,
    providerId: "test",
    user: {...adminUser, organizationId: orgId, accountId: uuidv7()},
    sessionId: uuidv7(),
    sessionContextVersion: 1n
  }
  const memberRequestor = {
    entityType: "user" as const,
    providerId: "test",
    user: {...memberUser, organizationId: orgId, accountId: uuidv7()},
    sessionId: uuidv7(),
    sessionContextVersion: 1n
  }

  const createModule = async (): Promise<TestingModule> => {
    const testModule = await Test.createTestingModule({
      imports: [ConfigModule, ServiceModule.register({runtime: "api"})]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: isolatedDb,
          redisPrefix
        })
      )
      .compile()

    await testModule.init()
    return testModule
  }

  beforeAll(async () => {
    isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    module = await createModule()
    service = module.get<UsageMeteringService>(UsageMeteringService)
    prisma = createFixturePrismaClient(isolatedDb)
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
    const now = new Date()
    await prisma.organization.create({
      data: {
        id: orgId,
        slug: `test-${orgId}`,
        displayName: "Usage test organization",
        planTier: "SELF_HOSTED_UNLIMITED",
        status: "active",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    })
    for (const metric of ALL_METERED_METRICS)
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
  })

  describe("cache recovery", () => {
    const metric: UsageMetric = "MAX_LLM_TOKENS_PER_MONTH"
    const input: AdmitAndReserveParams = {
      organizationId: orgId,
      operationId,
      entity,
      actor,
      metric,
      estimatedUnits: 100,
      period
    }
    const key = () => `${redisPrefix}usage:${orgId}:${metric}:${period}`
    const usage = async () =>
      unwrapRight(await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)())
        .metrics[0]

    it("restores acknowledged consumption and outstanding holds after cache loss without replaying consumption", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70})())
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())
      const outstanding = {...input, operationId: uuidv7(), estimatedUnits: 40}
      unwrapRight(await service.admitAndReserve(outstanding)())
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())

      expect(await usage()).toMatchObject({consumed: 70, reserved: 40})
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())
      unwrapRight(await service.admitAndReserve(outstanding)())
      expect(await usage()).toMatchObject({consumed: 70, reserved: 40})
      expect(await redisClient.ttl(key())).toBe(-1)

      unwrapRight(
        await service.cancelReservation({
          organizationId: orgId,
          operationId: outstanding.operationId,
          metric,
          estimatedUnits: 40,
          period
        })()
      )
      unwrapRight(await service.applySettlement({organizationId: orgId}, outstanding.operationId, "1")())
      expect(await usage()).toMatchObject({consumed: 70, reserved: 0})
      expect(await redisClient.ttl(key())).toBeGreaterThan(0)
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      expect(await usage()).toMatchObject({consumed: 70, reserved: 0})
      expect(await service.admitAndReserve({...outstanding, estimatedUnits: 41})()).toBeLeftOf("operation_mismatch")
    })

    it("rolls back the terminal operation and delivery records when the ledger write fails", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      const ledger = module.get<UsageEventRepository>(USAGE_EVENT_REPOSITORY_TOKEN)
      const persist = jest.spyOn(ledger, "persistOperation").mockReturnValueOnce(TE.left("event_mismatch"))
      const result = await service.settleUsage({...input, actualUnits: 70})()
      persist.mockRestore()

      expect(result).toBeLeftOf("event_mismatch")
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "reserved", occ: 0n})
      expect(await prisma.usageEvent.count()).toBe(0)
      expect(await prisma.usageSettlementIntent.count()).toBe(0)
      expect(await prisma.tenantOutbox.count()).toBe(0)
    })

    it("rolls back settlement when the database rejects its outbox insert", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      await prisma.$executeRawUnsafe(`ALTER TABLE public.tenant_outbox
        ADD CONSTRAINT reject_usage_settlement CHECK (event_type <> 'usage.settlement')`)
      try {
        const result = await service.settleUsage({...input, actualUnits: 70})()

        expect(result).toBeLeftOf("repository_dependency_error")
        expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "reserved", occ: 0n})
        expect(await prisma.usageSettlementIntent.count()).toBe(0)
        expect(await prisma.usageEvent.count()).toBe(0)
        expect(await prisma.tenantOutbox.count()).toBe(0)
      } finally {
        await prisma.$executeRawUnsafe("ALTER TABLE public.tenant_outbox DROP CONSTRAINT reject_usage_settlement")
      }
    })

    it("keeps the committed ledger and pending outbox when queue publication fails", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      const enqueue = jest.spyOn(module.get(QueueService), "enqueue").mockReturnValueOnce(TE.left("unknown_error"))
      const result = await service.settleUsage({...input, actualUnits: 70})()
      enqueue.mockRestore()

      expect(result).toBeRight()
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "settled", actualUnits: 70n})
      expect(await prisma.usageEvent.count()).toBe(1)
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toMatchObject({appliedAt: null})
      expect(await prisma.tenantOutbox.findFirstOrThrow()).toMatchObject({publishedAt: null})
    })

    it("reads historical usage without rebuilding an expired Redis key", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70})())
      await redisClient.del(key())
      expect(await usage()).toMatchObject({consumed: 70, reserved: 0})
      expect(await redisClient.exists(key())).toBe(0)
    })

    it("keeps same operation IDs separate across organizations and billing periods", async () => {
      const otherOrg = randomOrgId()
      await prisma.organization.create({
        data: {
          id: otherOrg,
          slug: `usage-${otherOrg}`,
          displayName: "Other usage",
          createdAt: new Date(),
          updatedAt: new Date(),
          planTier: "SELF_HOSTED_UNLIMITED",
          status: "active",
          occ: 0n
        }
      })
      for (const [organizationId, actualUnits] of [
        [orgId, 70],
        [otherOrg, 30]
      ] as const) {
        unwrapRight(await service.rebuildUsageCache({organizationId}, metric, period)())
        const operation = {...input, organizationId}
        unwrapRight(await service.admitAndReserve(operation)())
        unwrapRight(await service.settleUsage({...operation, actualUnits})())
        unwrapRight(await service.applySettlement({organizationId}, operationId, "1")())
        await redisClient.del(`${redisPrefix}usage:${organizationId}:${metric}:${period}`)
        unwrapRight(await service.rebuildUsageCache({organizationId}, metric, period)())
        // Settlement replay sees the terminal markers restored by the recovery worker.
        unwrapRight(await service.applySettlement({organizationId}, operationId, "1")())
        expect(
          await redisClient.hmget(`${redisPrefix}usage:${organizationId}:${metric}:${period}`, "consumed", "reserved")
        ).toEqual([String(actualUnits), "0"])
      }
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, "2026-09")())
      unwrapRight(
        await service.admitAndReserve({...input, operationId: uuidv7(), period: "2026-09", estimatedUnits: 25})()
      )
      expect(await redisClient.hmget(`${redisPrefix}usage:${orgId}:${metric}:2026-09`, "consumed", "reserved")).toEqual(
        ["0", "25"]
      )
      expect(await usage()).toMatchObject({consumed: 70, reserved: 0})
      expect(await prisma.usageEvent.count()).toBe(2)
    })

    it("blocks admission before writing a reservation while another rebuild owns the lease", async () => {
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      await redisClient.del(key())
      expect(unwrapRight(await cache.beginRebuild(key(), uuidv7())())).toBe("claimed")
      expect(await service.admitAndReserve(input)()).toBeLeftOf("quota_cache_unavailable")
      expect(await prisma.usageOperation.count()).toBe(0)
      await redisClient.hset(key(), "rebuildUntil", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0, reserved: 100})
    })

    it("keeps admission closed after a failed durable snapshot and rejects an incomplete immutable ledger", async () => {
      await redisClient.del(key())
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const snapshot = jest
        .spyOn(repository, "getUsageSnapshot")
        .mockReturnValueOnce(TE.left("repository_dependency_error"))
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toBeLeftOf(
        "repository_dependency_error"
      )
      snapshot.mockRestore()
      expect(await prisma.usageOperation.count()).toBe(0)
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      await redisClient.hset(key(), "rebuildUntil", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70})())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      // Fixture corruption deliberately breaks the operation/event invariant.
      await prisma.usageEvent.deleteMany({where: {organizationId: orgId}})
      await redisClient.del(key())
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toBeLeftOf(
        "operation_mismatch"
      )
      expect(await service.applySettlement({organizationId: orgId}, operationId, "1")()).toBeLeftOf(
        "quota_cache_unavailable"
      )
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toMatchObject({appliedAt: null})
    })

    it("replays a settlement committed after the rebuild snapshot without losing or doubling it", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      await redisClient.del(key())
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const restoreCache = cache.restore.bind(cache)
      const restore = jest.spyOn(cache, "restore").mockImplementationOnce((...args) =>
        pipe(
          service.settleUsage({...input, actualUnits: 70}),
          TE.mapLeft(error => ({type: "admission_error" as const, error})),
          TE.chain(() => restoreCache(...args))
        )
      )
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      expect(await redisClient.hmget(key(), "consumed", "reserved")).toEqual(["0", "100"])
      restore.mockRestore()
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())
      expect(await usage()).toMatchObject({consumed: 70, reserved: 0})
    })

    it("keeps admission closed when Redis cannot install a rebuilt snapshot", async () => {
      await redisClient.del(key())
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const restore = jest
        .spyOn(cache, "restore")
        .mockReturnValueOnce(TE.left({type: "admission_error", error: new Error("cache unavailable")}))
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toEqual(
        E.left({type: "admission_error", error: expect.any(Error)})
      )
      restore.mockRestore()
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      expect(await prisma.usageOperation.count()).toBe(0)
      await redisClient.hset(key(), "rebuildUntil", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0, reserved: 100})
    })

    it("recovers an ambiguous Redis reservation without releasing its durable hold", async () => {
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const reserveOperation = cache.reserveOperation.bind(cache)
      const reserve = jest.spyOn(cache, "reserveOperation").mockImplementationOnce((...args) =>
        pipe(
          reserveOperation(...args),
          TE.chainW(() => TE.left({type: "admission_error" as const, error: new Error("lost reply")}))
        )
      )
      expect(await service.admitAndReserve(input)()).toEqual(
        E.left({type: "admission_error", error: expect.any(Error)})
      )
      reserve.mockRestore()
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "reserved"})
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0, reserved: 100})
    })
  })

  describe("admitAndReserve", () => {
    it("should successfully admit and reserve capacity in UNLIMITED tier", async () => {
      // Given: SELF_HOSTED_UNLIMITED tier
      const params: AdmitAndReserveParams = {
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 2500,
        period
      }

      // When
      const result = await service.admitAndReserve(params)()
      const duplicate = await service.admitAndReserve(params)()

      // Expect
      expect(result).toBeRight()
      expect(duplicate).toBeRight()

      // Verify in Redis
      const usage = await service.getOrganizationUsage(
        adminRequestor,
        {organizationId: orgId},
        period,
        "MAX_LLM_TOKENS_PER_MONTH"
      )()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.limit).toBe("UNLIMITED")
      expect(firstMetric?.reserved).toBe(2500)
      expect(firstMetric?.consumed).toBe(0)
      expect(firstMetric?.remaining).toBe("UNLIMITED")
    })

    it("should reject reservation when estimated units exceed FREE tier limit", async () => {
      // Given: FREE tier has limit 0 for metered tokens
      await prisma.organization.update({where: {id: orgId}, data: {planTier: "FREE"}})
      const exceedingReservation: AdmitAndReserveParams = {
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100,
        period
      }

      // When
      const result = await service.admitAndReserve(exceedingReservation)()

      // Expect
      expect(result).toBeLeftOf("quota_exceeded")
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: AdmitAndReserveParams = {
        organizationId: orgId,
        operationId,
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
    it("should persist settlement intent and immutable usage event before applying the cache update", async () => {
      // Given: First reserve 2000 units
      const metric: UsageMetric = "MAX_EVALUATIONS_PER_MONTH"
      await service.admitAndReserve({
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric,
        estimatedUnits: 2000,
        period
      })()

      const settleParams: SettleUsageParams = {
        organizationId: orgId,
        operationId,
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

      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())

      // 1. Verify Redis balances: reservation released, actual consumed recorded
      const usage = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)()
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
        organizationId: orgId,
        operationId,
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
    it("should persist cancellation before releasing the reserved capacity hold", async () => {
      // Given: Reserve 1500 units
      const metric: UsageMetric = "MAX_CREDITS_PER_MONTH"
      await service.admitAndReserve({
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric,
        estimatedUnits: 1500,
        period
      })()

      const cancelParams: CancelReservationParams = {
        organizationId: orgId,
        operationId,
        metric,
        estimatedUnits: 1500,
        period
      }

      // When
      const result = await service.cancelReservation(cancelParams)()

      // Expect
      expect(result).toBeRight()

      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())

      // Verify in Redis
      const usage = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.reserved).toBe(0)
      expect(firstMetric?.consumed).toBe(0)
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: CancelReservationParams = {
        organizationId: orgId,
        operationId,
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
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000,
        period
      })()
      await service.settleUsage({
        organizationId: orgId,
        operationId,
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000,
        actualUnits: 3000,
        period
      })()
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId, "1")())

      // When
      const result = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period)()

      // Expect
      expect(result).toBeRight()
      const summary = unwrapRight(result)
      expect(summary.organizationId).toBe(orgId)
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
      const result = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, "invalid-period")()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_format")
    })

    it("should return requestor_not_authorized when caller is not an Org Admin", async () => {
      // When
      const result = await service.getOrganizationUsage(memberRequestor, {organizationId: orgId}, period)()

      // Expect
      expect(result).toBeLeftOf("requestor_not_authorized")
    })

    it("should reject an admin whose active organization differs from the requested tenant context", async () => {
      // When
      const result = await service.getOrganizationUsage(
        adminRequestor,
        {organizationId: toOrganizationId("018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e64")},
        period
      )()

      // Expect
      expect(result).toBeLeftOf("requestor_not_authorized")
    })
  })
})
