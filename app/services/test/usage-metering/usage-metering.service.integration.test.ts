import {POSTGRES_BIGINT_LOWER_BOUND} from "@external/database/constants"
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
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
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
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      entity,
      actor,
      metric,
      estimatedUnits: 100n,
      period
    }
    const key = () => `${redisPrefix}usage:${orgId}:${metric}:${period}`
    const usage = async () =>
      unwrapRight(await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)())
        .metrics[0]

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid reconciliation batch size %s",
      async batchSize => {
        // When
        const result = await service.reconcile({organizationId: orgId}, batchSize)()
        // Expect
        expect(result).toBeLeftOf("invalid_batch_size")
      }
    )

    it.each([
      [{...input, operationId: "invalid"}, "invalid_operation_id"],
      [{...input, entity: {...input.entity, id: "invalid"}}, "invalid_entity_id"],
      [{...input, actor: {...input.actor, id: "invalid"}}, "invalid_actor_id"],
      [{...input, estimatedUnits: -1n}, "invalid_estimated_units"],
      [{...input, estimatedUnits: 9223372036854775808n}, "invalid_estimated_units"]
    ] as const)("rejects invalid operation data before admission or settlement", async (params, error) => {
      // When
      const admission = await service.admitAndReserve(params)()
      // Expect
      expect(admission).toBeLeftOf(error)
      expect(await prisma.usageOperation.count()).toBe(0)

      // When
      const settlement = await service.settleUsage({...params, actualUnits: 10n})()
      // Expect
      expect(settlement).toBeLeftOf(error)
      expect(await prisma.usageOperation.count()).toBe(0)
    })

    it.each([-1n, 9223372036854775808n])("rejects invalid actual units %s", async actualUnits => {
      // When
      const result = await service.settleUsage({...input, actualUnits})()
      // Expect
      expect(result).toBeLeftOf("invalid_actual_units")
    })

    it("rejects invalid cancellation data", async () => {
      // When
      const invalidId = await service.cancelReservation({...input, operationId: "invalid"})()
      // Expect
      expect(invalidId).toBeLeftOf("invalid_operation_id")

      // When
      const invalidUnits = await service.cancelReservation({...input, estimatedUnits: -1n})()
      // Expect
      expect(invalidUnits).toBeLeftOf("invalid_estimated_units")
    })

    it.each([
      [new Date(0), "operation_expired"],
      [new Date(NaN), "invalid_operation_expires_at"]
    ] as const)("rejects invalid admission deadline %s", async (expiresAt, error) => {
      // When
      const result = await service.admitAndReserve({...input, expiresAt})()
      // Expect
      expect(result).toBeLeftOf(error)
      expect(await prisma.usageOperation.count()).toBe(0)
    })

    it("rejects an invalid recovery billing period", async () => {
      // When
      const result = await service.rebuildUsageCache({organizationId: orgId}, metric, "invalid")()
      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_format")
    })

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "reports invalid reserved-operation limit %s",
      async limit => {
        const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)

        expect(await repository.getReservedOperations({organizationId: orgId}, limit)()).toBeLeftOf("invalid_limit")
      }
    )

    it("reports a missing settlement intent", async () => {
      const result = await service.applySettlement({organizationId: orgId}, operationId)()

      expect(result).toBeLeftOf("settlement_not_found")
    })

    it("reports an unsupported stored settlement revision", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      await prisma.usageSettlementIntent.updateMany({where: {organizationId: orgId}, data: {revision: 2n}})

      const result = await service.reconcile({organizationId: orgId}, 10)()

      expect(result).toBeLeftOf("unsupported_settlement_revision")
    })

    it("preserves operation validation errors when loading a settlement", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      await prisma.usageOperation.updateMany({where: {organizationId: orgId}, data: {actorDisplayName: " "}})

      const result = await service.applySettlement({organizationId: orgId}, operationId)()

      expect(result).toBeLeftOf("invalid_actor")
    })

    it("persists a settlement acknowledgement once across repeated application", async () => {
      // Given
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      const context = {organizationId: orgId}
      const before = Date.now()

      // When
      unwrapRight(await service.applySettlement(context, operationId)())
      const stored = await prisma.usageSettlementIntent.findFirstOrThrow()
      unwrapRight(await service.applySettlement(context, operationId)())

      // Expect
      expect(stored.appliedAt).toBeInstanceOf(Date)
      expect(stored.appliedAt?.getTime()).toBeGreaterThanOrEqual(before)
      expect(stored.occ).toBe(1n)
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toEqual(stored)
    })

    it("rejects a stale settlement acknowledgement OCC without changing the intent", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      const context = {organizationId: orgId}
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const transactions = module.get<TenantTransactionManager>(TRANSACTION_MANAGER_TOKEN)

      const result = await transactions.execute(context, () =>
        repository.acknowledge(context, operationId, -1n, new Date())
      )()

      expect(result).toBeLeftOf("concurrency_error")
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toMatchObject({appliedAt: null, occ: 0n})
    })

    it("retries overlapping settlement acknowledgements and applies the intent once", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      const context = {organizationId: orgId}
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const read = repository.getSettlementApplicationState.bind(repository)
      let reads = 0
      let releaseReads: () => void = () => undefined
      const bothRead = new Promise<void>(resolve => {
        releaseReads = resolve
      })
      const get = jest.spyOn(repository, "getSettlementApplicationState").mockImplementation((...args) =>
        pipe(
          read(...args),
          TE.chainFirst(() =>
            TE.fromTask(async () => {
              reads++
              if (reads === 2) releaseReads()
              if (reads <= 2) await bothRead
            })
          )
        )
      )

      try {
        const results = await Promise.all([
          service.applySettlement(context, operationId)(),
          service.applySettlement(context, operationId)()
        ])

        expect(results).toEqual([E.right(undefined), E.right(undefined)])
        expect(reads).toBeGreaterThanOrEqual(3)
        const stored = await prisma.usageSettlementIntent.findFirstOrThrow()
        expect(stored.appliedAt).toBeInstanceOf(Date)
        expect(stored.occ).toBe(1n)
      } finally {
        get.mockRestore()
      }
    })

    it("persists the reservation identity and timestamps", async () => {
      // Given
      const before = Date.now()

      // When
      const result = await service.admitAndReserve(input)()

      // Expect
      expect(result).toBeRight()
      const stored = await prisma.usageOperation.findFirstOrThrow()
      expect(stored.operationId).toBe(operationId)
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(stored.updatedAt).toEqual(stored.createdAt)
      expect(stored.expiresAt).toEqual(input.expiresAt)
    })

    it("compares reservation facts independently of actor property order", async () => {
      // Given
      const initial = await service.admitAndReserve(input)()
      unwrapRight(initial)
      // When
      const replay = await service.admitAndReserve({
        ...input,
        actor: {displayName: actor.displayName, id: actor.id, type: actor.type}
      })()
      const changed = await service.admitAndReserve({...input, actor: {...actor, displayName: "Changed"}})()
      // Expect
      expect(replay).toBeRight()
      expect(changed).toBeLeftOf("operation_mismatch")
      expect(await prisma.usageOperation.count()).toBe(1)
    })

    it("reports a dependency failure when a skipped insert has no matching operation", async () => {
      // Given
      const initial = await service.admitAndReserve(input)()
      unwrapRight(initial)
      const stored = await prisma.usageOperation.findFirstOrThrow()
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const reserve = repository.reserve.bind(repository)
      // Simulate an internal row-ID collision while the requested operation ID is new.
      const collision = jest
        .spyOn(repository, "reserve")
        .mockImplementation((operation, creation) => reserve(operation, {...creation, id: stored.id}))
      // When
      const result = await service.admitAndReserve({...input, operationId: uuidv7()})()
      collision.mockRestore()
      // Expect
      expect(result).toBeLeftOf("repository_dependency_error")
      expect(await prisma.usageOperation.count()).toBe(1)
    })

    it("rejects malformed persisted operation metadata before cancellation", async () => {
      // Given
      const initial = await service.admitAndReserve(input)()
      unwrapRight(initial)
      await prisma.usageOperation.updateMany({where: {organizationId: orgId}, data: {actorDisplayName: " "}})
      // When
      const result = await service.cancelReservation(input)()
      // Expect
      expect(result).toBeLeftOf("invalid_actor")
      expect(await prisma.usageSettlementIntent.count()).toBe(0)
    })

    it.each([70n, 71n])("retries overlapping settlements with actual units 70 and %s", async actualUnits => {
      // Given
      const initial = await service.admitAndReserve(input)()
      unwrapRight(initial)
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const read = repository.get.bind(repository)
      let reads = 0
      let releaseReads: () => void = () => undefined
      const bothRead = new Promise<void>(resolve => {
        releaseReads = resolve
      })
      // Hold both first reads before either write so PostgreSQL must resolve a write conflict.
      // A retried transaction reads normally and validates the committed terminal outcome.
      const get = jest.spyOn(repository, "get").mockImplementation((...args) =>
        pipe(
          read(...args),
          TE.chainFirst(() =>
            TE.fromTask(async () => {
              reads++
              if (reads === 2) releaseReads()
              if (reads <= 2) await bothRead
            })
          )
        )
      )
      // When
      const results = await Promise.all([
        service.settleUsage({...input, actualUnits: 70n})(),
        service.settleUsage({...input, actualUnits})()
      ])
      get.mockRestore()
      // Expect
      expect(reads).toBeGreaterThanOrEqual(3)
      expect(results.filter(E.isRight)).toHaveLength(actualUnits === 70n ? 2 : 1)
      expect(results.filter(E.isLeft)).toEqual(actualUnits === 70n ? [] : [E.left("operation_mismatch")])
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({
        status: "settled",
        occ: POSTGRES_BIGINT_LOWER_BOUND + 1n
      })
      expect(await prisma.usageSettlementIntent.count()).toBe(1)
      expect(await prisma.usageEvent.count()).toBe(1)
      expect(await prisma.tenantOutbox.count()).toBe(1)
    })

    it("restores consumption and holds after cache loss despite unrelated OCC increments", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      await prisma.usageOperation.updateMany({
        where: {organizationId: orgId, operationId},
        data: {occ: {increment: 5}}
      })
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())
      const outstanding = {...input, operationId: uuidv7(), estimatedUnits: 40n}
      unwrapRight(await service.admitAndReserve(outstanding)())
      await prisma.usageOperation.updateMany({
        where: {organizationId: orgId},
        data: {occ: {increment: 3}}
      })
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())

      expect(await usage()).toMatchObject({consumed: 70n, reserved: 40n})
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())
      unwrapRight(await service.admitAndReserve(outstanding)())
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 40n})
      expect(await redisClient.ttl(key())).toBe(-1)

      unwrapRight(
        await service.cancelReservation({
          organizationId: orgId,
          operationId: outstanding.operationId,
          metric,
          estimatedUnits: 40n,
          period
        })()
      )
      unwrapRight(await service.applySettlement({organizationId: orgId}, outstanding.operationId)())
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 0n})
      expect(await redisClient.ttl(key())).toBeGreaterThan(0)
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 0n})
      expect(await service.admitAndReserve({...outstanding, estimatedUnits: 41n})()).toBeLeftOf("operation_mismatch")
    })

    it("rolls back the terminal operation and delivery records when the ledger write fails", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      const ledger = module.get<UsageEventRepository>(USAGE_EVENT_REPOSITORY_TOKEN)
      const persist = jest.spyOn(ledger, "getOrCreateById").mockReturnValueOnce(TE.left("unknown_error"))
      const result = await service.settleUsage({...input, actualUnits: 70n})()
      persist.mockRestore()

      expect(result).toBeLeftOf("unknown_error")
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({
        status: "reserved",
        occ: POSTGRES_BIGINT_LOWER_BOUND
      })
      expect(await prisma.usageEvent.count()).toBe(0)
      expect(await prisma.usageSettlementIntent.count()).toBe(0)
      expect(await prisma.tenantOutbox.count()).toBe(0)
    })

    it("keeps the committed ledger and pending outbox when queue publication fails", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      const enqueue = jest.spyOn(module.get(QueueService), "enqueue").mockReturnValueOnce(TE.left("unknown_error"))
      const result = await service.settleUsage({...input, actualUnits: 70n})()
      enqueue.mockRestore()

      expect(result).toBeRight()
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "settled", actualUnits: 70n})
      expect(await prisma.usageEvent.count()).toBe(1)
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toMatchObject({appliedAt: null})
      expect(await prisma.tenantOutbox.findFirstOrThrow()).toMatchObject({publishedAt: null})
    })

    it("reads historical usage without rebuilding an expired Redis key", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      await redisClient.del(key())
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 0n})
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
        [orgId, 70n],
        [otherOrg, 30n]
      ] as const) {
        unwrapRight(await service.rebuildUsageCache({organizationId}, metric, period)())
        const operation = {...input, organizationId}
        unwrapRight(await service.admitAndReserve(operation)())
        unwrapRight(await service.settleUsage({...operation, actualUnits})())
        unwrapRight(await service.applySettlement({organizationId}, operationId)())
        await redisClient.del(`${redisPrefix}usage:${organizationId}:${metric}:${period}`)
        unwrapRight(await service.rebuildUsageCache({organizationId}, metric, period)())
        // Settlement replay sees the terminal markers restored by the recovery worker.
        unwrapRight(await service.applySettlement({organizationId}, operationId)())
        expect(
          await redisClient.hmget(`${redisPrefix}usage:${organizationId}:${metric}:${period}`, "consumed", "reserved")
        ).toEqual([String(actualUnits), "0"])
      }
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, "2026-09")())
      unwrapRight(
        await service.admitAndReserve({...input, operationId: uuidv7(), period: "2026-09", estimatedUnits: 25n})()
      )
      expect(await redisClient.hmget(`${redisPrefix}usage:${orgId}:${metric}:2026-09`, "consumed", "reserved")).toEqual(
        ["0", "25"]
      )
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 0n})
      expect(await prisma.usageEvent.count()).toBe(2)
    })

    it("blocks admission before writing a reservation while another rebuild owns the lease", async () => {
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      await redisClient.del(key())
      expect(unwrapRight(await cache.beginRebuild(key(), uuidv7())())).toBe("claimed")
      expect(await service.admitAndReserve(input)()).toBeLeftOf("quota_cache_unavailable")
      expect(await prisma.usageOperation.count()).toBe(0)
      await redisClient.hset(key(), "rebuildLeaseExpiresAt", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0n, reserved: 100n})
    })

    it("keeps admission closed after a failed durable snapshot and rejects an incomplete immutable ledger", async () => {
      await redisClient.del(key())
      const repository = module.get<UsageOperationRepository>(USAGE_OPERATION_REPOSITORY_TOKEN)
      const snapshot = jest
        .spyOn(repository, "getOperationStates")
        .mockReturnValueOnce(TE.left("repository_dependency_error"))
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toBeLeftOf(
        "repository_dependency_error"
      )
      snapshot.mockRestore()
      expect(await prisma.usageOperation.count()).toBe(0)
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      await redisClient.hset(key(), "rebuildLeaseExpiresAt", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage({...input, actualUnits: 70n})())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      // Fixture corruption deliberately breaks the operation/event invariant.
      await prisma.usageEvent.deleteMany({where: {organizationId: orgId}})
      await redisClient.del(key())
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toBeLeftOf(
        "operation_mismatch"
      )
      expect(await service.applySettlement({organizationId: orgId}, operationId)()).toBeLeftOf(
        "quota_cache_unavailable"
      )
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      expect(await prisma.usageSettlementIntent.findFirstOrThrow()).toMatchObject({appliedAt: null})
    })

    it("keeps admission closed when a stored reservation has actual units", async () => {
      // Given
      unwrapRight(await service.admitAndReserve(input)())
      await prisma.usageOperation.updateMany({where: {organizationId: orgId}, data: {actualUnits: 0n}})
      await redisClient.del(key())

      // When
      const result = await service.rebuildUsageCache({organizationId: orgId}, metric, period)()

      // Expect
      expect(result).toBeLeftOf("invalid_actual_units")
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      expect(await service.admitAndReserve({...input, operationId: uuidv7()})()).toBeLeftOf("quota_cache_unavailable")
    })

    it("rebuilds usage after cancellation without counting the released reservation", async () => {
      // Given
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.cancelReservation(input)())
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "cancelled", actualUnits: null})
      await redisClient.del(key())

      // When
      const result = await service.rebuildUsageCache({organizationId: orgId}, metric, period)()

      // Expect
      expect(result).toBeRight()
      expect(await usage()).toMatchObject({consumed: 0n, reserved: 0n})
    })

    it("replays a settlement committed after the rebuild snapshot without losing or doubling it", async () => {
      unwrapRight(await service.admitAndReserve(input)())
      await redisClient.del(key())
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const restoreCache = cache.restore.bind(cache)
      const restore = jest.spyOn(cache, "restore").mockImplementationOnce((...args) =>
        pipe(
          service.settleUsage({...input, actualUnits: 70n}),
          TE.mapLeft(() => "admission_error" as const),
          TE.chain(() => restoreCache(...args))
        )
      )
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      expect(await redisClient.hmget(key(), "consumed", "reserved")).toEqual(["0", "100"])
      restore.mockRestore()
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())
      expect(await usage()).toMatchObject({consumed: 70n, reserved: 0n})
    })

    it("keeps admission closed when Redis cannot install a rebuilt snapshot", async () => {
      await redisClient.del(key())
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const restore = jest.spyOn(cache, "restore").mockReturnValueOnce(TE.left("admission_error"))
      expect(await service.rebuildUsageCache({organizationId: orgId}, metric, period)()).toEqual(
        E.left("admission_error")
      )
      restore.mockRestore()
      expect(await redisClient.hget(key(), "ready")).toBeNull()
      expect(await prisma.usageOperation.count()).toBe(0)
      await redisClient.hset(key(), "rebuildLeaseExpiresAt", "0")
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0n, reserved: 100n})
    })

    it("recovers an ambiguous Redis reservation without releasing its durable hold", async () => {
      const cache = module.get<QuotaAdmissionClient>(QUOTA_ADMISSION_CLIENT_TOKEN)
      const reserveOperation = cache.reserveOperation.bind(cache)
      const reserve = jest.spyOn(cache, "reserveOperation").mockImplementationOnce((...args) =>
        pipe(
          reserveOperation(...args),
          TE.chainW(() => TE.left("admission_error" as const))
        )
      )
      expect(await service.admitAndReserve(input)()).toEqual(E.left("admission_error"))
      reserve.mockRestore()
      expect(await prisma.usageOperation.findFirstOrThrow()).toMatchObject({status: "reserved"})
      await redisClient.del(key())
      unwrapRight(await service.rebuildUsageCache({organizationId: orgId}, metric, period)())
      unwrapRight(await service.admitAndReserve(input)())
      expect(await usage()).toMatchObject({consumed: 0n, reserved: 100n})
    })
  })

  describe("admitAndReserve", () => {
    it("should successfully admit and reserve capacity in UNLIMITED tier", async () => {
      // Given: SELF_HOSTED_UNLIMITED tier
      const params: AdmitAndReserveParams = {
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 2500n,
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
      expect(firstMetric?.reserved).toBe(2500n)
      expect(firstMetric?.consumed).toBe(0n)
      expect(firstMetric?.remaining).toBe("UNLIMITED")
    })

    it("should reject reservation when estimated units exceed FREE tier limit", async () => {
      // Given: FREE tier has limit 0 for metered tokens
      await prisma.organization.update({where: {id: orgId}, data: {planTier: "FREE"}})
      const exceedingReservation: AdmitAndReserveParams = {
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100n,
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
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100n,
        period: "invalid-date"
      }

      // When
      const result = await service.admitAndReserve(params)()

      // Expect
      expect(result).toBeLeftOf("billing_period_invalid_format")
    })
  })

  describe("settleUsage", () => {
    it("accepts identical ledger retries and rejects changed metadata in the service", async () => {
      // Given
      const input: SettleUsageParams = {
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100n,
        actualUnits: 70n,
        period,
        metadata: {first: 1, second: 2}
      }
      unwrapRight(await service.admitAndReserve(input)())
      unwrapRight(await service.settleUsage(input)())

      // When
      const identical = await service.settleUsage({...input, metadata: {second: 2, first: 1}})()
      const changed = await service.settleUsage({...input, metadata: {first: 3, second: 2}})()

      // Expect
      expect(identical).toBeRight()
      expect(changed).toBeLeftOf("event_mismatch")
      expect(await prisma.usageEvent.count()).toBe(1)
      expect(await prisma.usageSettlementIntent.count()).toBe(1)
      expect(await prisma.tenantOutbox.count()).toBe(1)
      expect((await prisma.usageEvent.findFirstOrThrow()).metadata).toEqual(input.metadata)
    })

    it("should persist settlement intent and immutable usage event before applying the cache update", async () => {
      // Given: First reserve 2000 units
      const metric: UsageMetric = "MAX_EVALUATIONS_PER_MONTH"
      await service.admitAndReserve({
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric,
        estimatedUnits: 2000n,
        period
      })()

      const settleParams: SettleUsageParams = {
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric,
        estimatedUnits: 2000n,
        actualUnits: 1800n,
        period,
        isBillable: true,
        metadata: {workflowExecutionId: "exec-123"}
      }

      // When
      const result = await service.settleUsage(settleParams)()

      // Expect
      expect(result).toBeRight()

      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())

      // 1. Verify Redis balances: reservation released, actual consumed recorded
      const usage = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.reserved).toBe(0n)
      expect(firstMetric?.consumed).toBe(1800n)

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
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 100n,
        actualUnits: 100n,
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
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric,
        estimatedUnits: 1500n,
        period
      })()

      const cancelParams: CancelReservationParams = {
        organizationId: orgId,
        operationId,
        metric,
        estimatedUnits: 1500n,
        period
      }

      // When
      const result = await service.cancelReservation(cancelParams)()

      // Expect
      expect(result).toBeRight()

      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())

      // Verify in Redis
      const usage = await service.getOrganizationUsage(adminRequestor, {organizationId: orgId}, period, metric)()
      const summary = unwrapRight(usage)
      const firstMetric = summary.metrics[0]
      expect(firstMetric?.reserved).toBe(0n)
      expect(firstMetric?.consumed).toBe(0n)
    })

    it("should return validation error on malformed billing period", async () => {
      // Given
      const params: CancelReservationParams = {
        organizationId: orgId,
        operationId,
        metric: "MAX_CREDITS_PER_MONTH",
        estimatedUnits: 100n,
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
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000n,
        period
      })()
      await service.settleUsage({
        organizationId: orgId,
        operationId,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        entity,
        actor,
        metric: "MAX_LLM_TOKENS_PER_MONTH",
        estimatedUnits: 3000n,
        actualUnits: 3000n,
        period
      })()
      unwrapRight(await service.applySettlement({organizationId: orgId}, operationId)())

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
      expect(tokenMetric?.consumed).toBe(3000n)
      expect(tokenMetric?.unit).toBe("tokens")
      expect(tokenMetric?.limit).toBe("UNLIMITED")
      expect(tokenMetric?.remaining).toBe("UNLIMITED")

      const evalMetric = summary.metrics.find(m => m.metric === "MAX_EVALUATIONS_PER_MONTH")
      expect(evalMetric).toBeDefined()
      expect(evalMetric?.consumed).toBe(0n)
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
