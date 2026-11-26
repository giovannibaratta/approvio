import {UsageQuotaLimit} from "@domain"
import {UsageCacheSnapshotFactory, UsageCacheOperationFactory} from "@services/usage-metering"
import {UsageSettlementResult, UsageSettlementResultFactory} from "@services/durable-work/models"
import {UsageSnapshot, UsageSnapshotFactory} from "@services/durable-work/models"
import {ConfigModule, RedisClient, RedisQuotaAdmissionClient, buildQuotaUsageKey} from "@external"
import {ConfigProvider} from "@external/config"
import {USAGE_QUANTITY_LUA} from "@external/redis/usage-quantity.lua"
import {Test, TestingModule} from "@nestjs/testing"
import * as E from "fp-ts/Either"
import {cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import {parse as parseUuid, v7 as uuidv7} from "uuid"

const operationExpiresAt = new Date("2099-01-01T00:00:00Z")

describe("RedisQuotaAdmissionClient Integration", () => {
  let admissionClient: RedisQuotaAdmissionClient
  let redisClient: RedisClient
  let redisPrefix: string

  const restoreCache = (key: string, owner: string, snapshot: UsageSnapshot, retainUntil: Date) =>
    admissionClient.restore(key, owner, UsageCacheSnapshotFactory.create(snapshot, retainUntil))

  const reserveOperation = (
    key: string,
    operationId: string,
    limit: UsageQuotaLimit,
    estimate: bigint,
    expiresAt = operationExpiresAt
  ) =>
    admissionClient.reserveOperation(key, UsageCacheOperationFactory.reserve(operationId, limit, estimate, expiresAt))

  const applySettlement = (
    key: string,
    operationId: string,
    estimate: bigint,
    result: UsageSettlementResult,
    expiresAt = operationExpiresAt
  ) => admissionClient.applySettlement(key, UsageCacheOperationFactory.settle(operationId, estimate, result, expiresAt))

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [RedisClient, RedisQuotaAdmissionClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(
        MockConfigProvider.fromOriginalProvider({
          tenantConnectionUrl: isolatedDb,
          redisPrefix
        })
      )
      .compile()

    redisClient = module.get(RedisClient)
    admissionClient = module.get(RedisQuotaAdmissionClient)
    await module.init()
  }, 30000)

  afterEach(async () => {
    await cleanRedisByPrefix(redisPrefix)
    if (redisClient) redisClient.disconnect()
  })

  it("keeps Lua arithmetic and validation exact at the bigint boundary", async () => {
    // Given
    const script =
      USAGE_QUANTITY_LUA +
      `
      return {
        add(ARGV[1], '1'),
        subtract(ARGV[1], ARGV[2]),
        compare(ARGV[1], ARGV[2]),
        tostring(is_quantity(ARGV[1])),
        tostring(is_quantity(add(ARGV[1], '1'))),
        tostring(is_quantity('01'))
      }
    `

    // When
    const result = await redisClient.eval(script, 0, "9223372036854775807", "9223372036854775806")

    // Expect
    expect(result).toEqual(["9223372036854775808", "1", 1, "true", "false", "false"])
  })

  describe("buildQuotaUsageKey", () => {
    it("should format key correctly", () => {
      // Given
      const orgId = "org-123"
      const metric = "llm_tokens"
      const billingPeriodId = "2025-05"

      // When
      const key = buildQuotaUsageKey(orgId, metric, billingPeriodId)

      // Expect
      expect(key).toBe("usage:org-123:llm_tokens:2025-05")
    })
  })

  describe("reserve and settle lifecycle", () => {
    it("should perform sequential reservation, settlement, and usage tracking", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 1000n
      const firstOperation = uuidv7()
      const secondOperation = uuidv7()
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 80n}))

      // When: Initial reservation
      const reserveRes1 = await reserveOperation(key, firstOperation, limit, 100n)()

      // Expect
      expect(reserveRes1).toBeRightOf({
        consumed: 0n,
        reserved: 100n
      })

      // When: Check usage after reservation
      const usage1 = await admissionClient.getUsage(key)()

      // Expect
      expect(usage1).toBeRightOf({consumed: 0n, reserved: 100n})

      // When: Settle with estimate 100 and actual 80
      const settledConsumed = await applySettlement(key, firstOperation, 100n, settlement)()

      // Expect
      expect(settledConsumed).toBeRightOf(80n)

      // When: Check usage after settlement
      const usage2 = await admissionClient.getUsage(key)()

      // Expect
      expect(usage2).toBeRightOf({consumed: 80n, reserved: 0n})

      // When: Second reservation with current consumed = 80
      const reserveRes2 = await reserveOperation(key, secondOperation, limit, 200n)()

      // Expect
      expect(reserveRes2).toBeRightOf({
        consumed: 80n,
        reserved: 200n
      })

      // When: Check usage after second reservation
      const usage3 = await admissionClient.getUsage(key)()

      // Expect
      expect(usage3).toBeRightOf({consumed: 80n, reserved: 200n})
    })
  })

  describe("limit enforcement", () => {
    it("should reject reservation when limit would be exceeded", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 100n

      // When: Reserve 80 out of 100
      const res1 = await reserveOperation(key, uuidv7(), limit, 80n)()

      // Expect
      expect(res1).toBeRightOf({consumed: 0n, reserved: 80n})

      // When: Attempt to reserve 30 (80 + 30 = 110 > 100) -> should be rejected
      const res2 = await reserveOperation(key, uuidv7(), limit, 30n)()

      // Expect
      expect(res2).toBeLeftOf("quota_exceeded")

      // When: Check usage to ensure hash state was preserved
      const usage = await admissionClient.getUsage(key)()

      // Expect
      expect(usage).toBeRightOf({consumed: 0n, reserved: 80n})
    })

    it("should allow unlimited mode when limit is UNLIMITED", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = "UNLIMITED"

      // When
      const res = await reserveOperation(key, uuidv7(), limit, 1_000_000n)()

      // Expect
      expect(res).toBeRightOf({
        consumed: 0n,
        reserved: 1_000_000n
      })
    })
  })

  describe("release", () => {
    it("should release reserved capacity after operation failure", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 500n
      const cancellation = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))

      // When: Reserve capacity
      const operationId = uuidv7()
      const res1 = await reserveOperation(key, operationId, limit, 150n)()

      // Expect
      expect(res1).toBeRightOf({consumed: 0n, reserved: 150n})

      // When: Release reserved capacity
      const released = await applySettlement(key, operationId, 150n, cancellation)()
      const usage = await admissionClient.getUsage(key)()

      // Expect: Verify reserved capacity is 0
      expect(released).toBeRight()
      expect(usage).toBeRightOf({consumed: 0n, reserved: 0n})
    })
  })

  describe("operation settlement idempotency", () => {
    it("applies a durable operation reservation and settlement once", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const operationId = "019a1234-5678-7abc-8def-0123456789ab"
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 70n}))
      const cancellation = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))

      // When
      const first = await reserveOperation(key, operationId, 100n, 80n)()
      const duplicate = await reserveOperation(key, operationId, 100n, 80n)()

      // Expect
      expect(first).toBeRightOf({consumed: 0n, reserved: 80n})
      expect(duplicate).toEqual(first)

      // When: the same settlement is delivered twice.
      const settled = await applySettlement(key, operationId, 80n, settlement)()
      const replay = await applySettlement(key, operationId, 80n, settlement)()
      // Expect
      expect(settled).toBeRight()
      expect(replay).toBeRight()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70n, reserved: 0n})

      // When / Expect: a conflicting terminal outcome is rejected.
      expect(await applySettlement(key, operationId, 80n, cancellation)()).toBeLeftOf("operation_mismatch")
    })
  })

  describe("recovery fencing and retention", () => {
    it("drops a completed field whose expiry elapsed after service preparation", async () => {
      // Given
      const key = `${redisPrefix}expiry-during-preparation`
      const owner = uuidv7()
      const operationId = uuidv7()
      const hour = 60 * 60 * 1000
      const expiresAt = new Date(Date.now() - 49 * hour)
      const snapshot = unwrapRight(
        UsageSnapshotFactory.validate({
          consumed: 12n,
          operations: [
            {operationId, estimatedUnits: 20n, state: "settled", actualUnits: 12n, expiresAt, completedAt: expiresAt}
          ]
        })
      )
      const retainUntil = new Date(Date.now() + 86400000)
      const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * hour)
      const prepared = UsageCacheSnapshotFactory.create(snapshot, retainUntil)
      clock.mockRestore()
      expect(prepared.operations).toHaveLength(1)
      unwrapRight(await admissionClient.beginRebuild(key, owner)())

      // When
      const restored = await admissionClient.restore(key, owner, prepared)()

      // Expect
      expect(restored).toBeRight()
      expect(await redisClient.hget(key, Buffer.from(parseUuid(operationId)))).toBeNull()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 12n, reserved: 0n})
    })

    it("publishes large replacements without exceeding JavaScript's function-argument limit", async () => {
      // Given
      const key = `${redisPrefix}large-replacement`
      const owner = uuidv7()
      const expiresAt = new Date(Date.now() + 60000)
      const snapshot = unwrapRight(
        UsageSnapshotFactory.validate({
          consumed: 0n,
          operations: Array.from({length: 50000}, () => ({
            operationId: uuidv7(),
            estimatedUnits: 1n,
            state: "reserved",
            expiresAt
          }))
        })
      )
      const prepared = UsageCacheSnapshotFactory.create(snapshot, new Date(Date.now() + 86400000))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())

      // When
      const restored = await admissionClient.restore(key, owner, prepared)()

      // Expect
      expect(restored).toBeRight()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 0n, reserved: 50000n})
      expect(await redisClient.hlen(key)).toBe(50004)
    }, 15000)

    it("stores completed deadline-bound operations as expiring markers with exact binary IDs", async () => {
      // Given
      const key = `${redisPrefix}compact-markers`
      const owner = uuidv7()
      const operationId = uuidv7()
      const field = Buffer.from(parseUuid(operationId))
      const expiresAt = new Date(Date.now() + 60000)
      const snapshot = unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []}))
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 12n}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      unwrapRight(await restoreCache(key, owner, snapshot, new Date(Date.now() + 86400000))())
      unwrapRight(await reserveOperation(key, operationId, 100n, 20n, expiresAt)())

      expect(await redisClient.call("HPTTL", key, "FIELDS", 1, field)).toEqual([-1])

      // When
      const settled = await applySettlement(key, operationId, 20n, settlement, expiresAt)()

      // Expect
      expect(settled).toBeRight()
      expect(field.byteLength).toBe(16)
      expect(await redisClient.hget(key, field)).toBe("S")
      expect(await redisClient.hget(key, `operation:${operationId}`)).toBeNull()
      expect(await redisClient.call("HPEXPIRETIME", key, "FIELDS", 1, field)).toEqual([
        expiresAt.getTime() + 48 * 60 * 60 * 1000
      ])
      // When: the settlement is replayed.
      const replay = await applySettlement(key, operationId, 20n, settlement, expiresAt)()

      // Expect
      expect(replay).toBeRight()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 12n, reserved: 0n})
      expect(await reserveOperation(key, operationId, 100n, 20n, expiresAt)()).toBeLeftOf("operation_mismatch")
    })

    it("stores cancellation as an expiring marker that blocks readmission", async () => {
      // Given
      const key = `${redisPrefix}compact-cancellation`
      const owner = uuidv7()
      const operationId = uuidv7()
      const field = Buffer.from(parseUuid(operationId))
      const expiresAt = new Date(Date.now() + 60000)
      const snapshot = unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []}))
      const cancellation = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      unwrapRight(await restoreCache(key, owner, snapshot, new Date(Date.now() + 86400000))())
      unwrapRight(await reserveOperation(key, operationId, 100n, 20n, expiresAt)())
      // When
      const cancelled = await applySettlement(key, operationId, 20n, cancellation, expiresAt)()

      // Expect
      expect(cancelled).toBeRight()
      expect(await redisClient.hget(key, field)).toBe("C")
      expect(await redisClient.call("HPEXPIRETIME", key, "FIELDS", 1, field)).toEqual([
        expiresAt.getTime() + 48 * 60 * 60 * 1000
      ])
      expect(await reserveOperation(key, operationId, 100n, 20n, expiresAt)()).toBeLeftOf("operation_mismatch")
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 0n, reserved: 0n})
    })

    it("does not restore expired completed markers or apply their usage again", async () => {
      // Given
      const key = `${redisPrefix}expired-markers`
      const owner = uuidv7()
      const operationId = uuidv7()
      const cancelledId = uuidv7()
      const expiresAt = new Date(Date.now() - 72 * 60 * 60 * 1000)
      const snapshot = unwrapRight(
        UsageSnapshotFactory.validate({
          consumed: 12n,
          operations: [
            {operationId, estimatedUnits: 20n, state: "settled", actualUnits: 12n, expiresAt, completedAt: expiresAt},
            {operationId: cancelledId, estimatedUnits: 5n, state: "cancelled", expiresAt, completedAt: expiresAt}
          ]
        })
      )
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 12n}))
      const cancellation = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      // When
      const restored = await restoreCache(key, owner, snapshot, new Date(Date.now() + 86400000))()

      // Expect
      expect(restored).toBeRight()
      expect(await redisClient.hget(key, Buffer.from(parseUuid(operationId)))).toBeNull()
      expect(await redisClient.hget(key, Buffer.from(parseUuid(cancelledId)))).toBeNull()
      // When: terminal operations are replayed.
      const settled = await applySettlement(key, operationId, 20n, settlement, expiresAt)()
      const cancelled = await applySettlement(key, cancelledId, 5n, cancellation, expiresAt)()
      // Expect
      expect(settled).toBeRight()
      expect(cancelled).toBeRight()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 12n, reserved: 0n})
      expect(await reserveOperation(key, cancelledId, 100n, 5n, expiresAt)()).toBeLeftOf("operation_expired")
    })

    it("keeps old unresolved holds and permits their late settlement", async () => {
      // Given
      const key = `${redisPrefix}late-completion`
      const owner = uuidv7()
      const operationId = uuidv7()
      const expiresAt = new Date(Date.now() - 72 * 60 * 60 * 1000)
      const snapshot = unwrapRight(
        UsageSnapshotFactory.validate({
          consumed: 0n,
          operations: [{operationId, estimatedUnits: 20n, state: "reserved", expiresAt}]
        })
      )
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 12n}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      // When
      const restored = await restoreCache(key, owner, snapshot, new Date(0))()

      // Expect
      expect(restored).toBeRight()
      expect(await redisClient.ttl(key)).toBe(-1)
      expect(await redisClient.call("HPTTL", key, "FIELDS", 1, Buffer.from(parseUuid(operationId)))).toEqual([-1])

      // When
      const settled = await applySettlement(key, operationId, 20n, settlement, expiresAt)()

      // Expect
      expect(settled).toBeRight()
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 12n, reserved: 0n})
      expect(await redisClient.hget(key, Buffer.from(parseUuid(operationId)))).toBe("S")
    })

    it("rejects expired admission before looking for a ready cache", async () => {
      // Given
      const key = `${redisPrefix}expired-admission`

      // When
      const result = await reserveOperation(key, uuidv7(), 100n, 20n, new Date(0))()

      // Expect
      expect(result).toBeLeftOf("operation_expired")
      expect(await redisClient.exists(key)).toBe(0)
    })

    it("rejects publishing after the rebuild lease expires", async () => {
      // Given
      const key = `${redisPrefix}expired-rebuild`
      const owner = uuidv7()
      const snapshot = unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      await redisClient.hset(key, "rebuildLeaseExpiresAt", "0")

      // When
      const result = await restoreCache(key, owner, snapshot, new Date(0))()

      // Expect
      expect(result).toBeLeftOf("rebuild_lease_lost")
      expect(await redisClient.hget(key, "ready")).toBeNull()
    })

    it("reports settlement without a cached hold as inconsistent", async () => {
      // Given
      const key = `${redisPrefix}missing-hold`
      const owner = uuidv7()
      const snapshot = unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []}))
      const settlement = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 1n}))
      unwrapRight(await admissionClient.beginRebuild(key, owner)())
      unwrapRight(await restoreCache(key, owner, snapshot, new Date(0))())
      const before = await redisClient.hgetall(key)

      // When
      const result = await applySettlement(key, uuidv7(), 1n, settlement)()

      // Expect
      expect(result).toBeLeftOf("usage_cache_inconsistent")
      expect(await redisClient.hgetall(key)).toEqual(before)
    })

    it("rejects missing-cache admission and stale rebuild owners", async () => {
      // Given
      const key = `${redisPrefix}recovery`
      const oldOwner = uuidv7()
      const newOwner = uuidv7()
      const operationId = uuidv7()
      // When / Expect: admission remains closed until a rebuild owns the cache.
      expect(await reserveOperation(key, operationId, 100n, 40n)()).toBeLeftOf("cache_unavailable")
      expect(await admissionClient.getUsage(key)()).toBeLeftOf("cache_unavailable")
      expect(unwrapRight(await admissionClient.beginRebuild(key, oldOwner)())).toBe("claimed")
      expect(unwrapRight(await admissionClient.beginRebuild(key, newOwner)())).toBe("busy")
      await redisClient.hset(key, "rebuildLeaseExpiresAt", "0")
      expect(unwrapRight(await admissionClient.beginRebuild(key, newOwner)())).toBe("claimed")
      const snapshot = unwrapRight(
        UsageSnapshotFactory.validate({
          consumed: 70n,
          operations: [{operationId, estimatedUnits: 40n, state: "reserved" as const, expiresAt: operationExpiresAt}]
        })
      )
      // When / Expect: the expired owner cannot publish its snapshot.
      expect(await restoreCache(key, oldOwner, snapshot, new Date(0))()).toBeLeftOf("rebuild_lease_lost")

      // When: the current owner publishes the snapshot.
      const restored = await restoreCache(key, newOwner, snapshot, new Date(0))()

      // Expect
      expect(restored).toBeRight()
      expect(await redisClient.hget(key, Buffer.from(parseUuid(operationId)))).toBe("pending_admission|40")
      expect(await reserveOperation(key, operationId, 100n, 40n)()).toBeLeftOf("quota_exceeded")
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70n, reserved: 40n})
      expect(await redisClient.ttl(key)).toBe(-1)

      const cancellation = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))

      // When: the outstanding operation is cancelled.
      const cancelled = await applySettlement(key, operationId, 40n, cancellation)()

      // Expect
      expect(cancelled).toBeRight()
      expect(await redisClient.ttl(key)).toBeGreaterThan(0)
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70n, reserved: 0n})
    })
  })

  it("replays restored terminal outcomes without applying consumption again", async () => {
    // Given
    const key = `${redisPrefix}usage:terminal-recovery`
    const owner = uuidv7()
    const settledId = uuidv7()
    const cancelledId = uuidv7()
    const snapshot = unwrapRight(
      UsageSnapshotFactory.validate({
        consumed: 25n,
        operations: [
          {
            operationId: settledId,
            estimatedUnits: 40n,
            state: "settled",
            actualUnits: 25n,
            expiresAt: operationExpiresAt,
            completedAt: new Date()
          },
          {
            operationId: cancelledId,
            estimatedUnits: 10n,
            state: "cancelled",
            expiresAt: operationExpiresAt,
            completedAt: new Date()
          }
        ]
      })
    )
    unwrapRight(await admissionClient.beginRebuild(key, owner)())
    unwrapRight(await restoreCache(key, owner, snapshot, new Date(Date.now() + 60_000))())
    const settled = unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 25n}))
    const cancelled = unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))

    // When
    const settlementReplay = await applySettlement(key, settledId, 40n, settled)()
    const cancellationReplay = await applySettlement(key, cancelledId, 10n, cancelled)()
    const mismatch = await applySettlement(key, settledId, 40n, cancelled)()
    const usage = await admissionClient.getUsage(key)()

    // Expect
    expect(settlementReplay).toBeRightOf(25n)
    expect(cancellationReplay).toBeRightOf(25n)
    expect(mismatch).toBeLeftOf("operation_mismatch")
    expect(usage).toBeRightOf({consumed: 25n, reserved: 0n})
    expect(await redisClient.hget(key, Buffer.from(parseUuid(settledId)))).toBe("S")
    expect(await redisClient.hget(key, Buffer.from(parseUuid(cancelledId)))).toBe("C")
  })

  it.each([9007199254740993n, 9223372036854775807n])(
    "preserves exact reservations, quota comparisons, and settlements for %s units",
    async quantity => {
      // Given
      const key = `${redisPrefix}large-quantity`
      const owner = uuidv7()
      const operationId = uuidv7()
      const snapshotResult = UsageSnapshotFactory.validate({consumed: 0n, operations: []})
      const snapshot = unwrapRight(snapshotResult)
      const claim = await admissionClient.beginRebuild(key, owner)()
      unwrapRight(claim)
      const restored = await restoreCache(key, owner, snapshot, new Date(Date.now() + 60_000))()
      unwrapRight(restored)
      const settlementResult = UsageSettlementResultFactory.validate({state: "settled", actualUnits: quantity - 1n})
      const settlement = unwrapRight(settlementResult)
      // When
      const denied = await reserveOperation(key, operationId, quantity - 1n, quantity)()
      const reserved = await reserveOperation(key, operationId, quantity, quantity)()
      const settled = await applySettlement(key, operationId, quantity, settlement)()
      const replay = await applySettlement(key, operationId, quantity, settlement)()
      const usage = await admissionClient.getUsage(key)()
      // Expect
      expect(denied).toBeLeftOf("quota_exceeded")
      expect(reserved).toBeRightOf({consumed: 0n, reserved: quantity})
      expect(settled).toBeRightOf(quantity - 1n)
      expect(replay).toEqual(settled)
      expect(usage).toBeRightOf({consumed: quantity - 1n, reserved: 0n})
      expect(await redisClient.hget(key, Buffer.from(parseUuid(operationId)))).toBe("S")
    }
  )

  it("preserves decimal carries and borrows across multiple large holds", async () => {
    // Given
    const key = `${redisPrefix}large-holds`
    const owner = uuidv7()
    const first = uuidv7()
    const second = uuidv7()
    const estimate = 9007199254740999n
    const snapshotResult = UsageSnapshotFactory.validate({consumed: 0n, operations: []})
    const snapshot = unwrapRight(snapshotResult)
    const claim = await admissionClient.beginRebuild(key, owner)()
    unwrapRight(claim)
    const restored = await restoreCache(key, owner, snapshot, new Date(Date.now() + 60_000))()
    unwrapRight(restored)
    const cancellationResult = UsageSettlementResultFactory.validate({state: "cancelled"})
    const cancellation = unwrapRight(cancellationResult)
    // When
    const firstHold = await reserveOperation(key, first, "UNLIMITED", estimate)()
    const secondHold = await reserveOperation(key, second, "UNLIMITED", 1n)()
    const cancelled = await applySettlement(key, first, estimate, cancellation)()
    const usage = await admissionClient.getUsage(key)()
    // Expect
    expect(firstHold).toBeRightOf({consumed: 0n, reserved: estimate})
    expect(secondHold).toBeRightOf({consumed: 0n, reserved: 9007199254741000n})
    expect(cancelled).toBeRightOf(0n)
    expect(usage).toBeRightOf({consumed: 0n, reserved: 1n})
  })

  it("rejects reservation overflow before changing counters or replay markers", async () => {
    // Given
    const key = `${redisPrefix}reservation-overflow`
    const owner = uuidv7()
    const snapshotResult = UsageSnapshotFactory.validate({consumed: 9223372036854775807n, operations: []})
    const snapshot = unwrapRight(snapshotResult)
    const claim = await admissionClient.beginRebuild(key, owner)()
    unwrapRight(claim)
    const restored = await restoreCache(key, owner, snapshot, new Date(Date.now() + 60_000))()
    unwrapRight(restored)
    const before = await redisClient.hgetall(key)
    // When
    const result = await reserveOperation(key, uuidv7(), "UNLIMITED", 1n)()
    // Expect
    expect(result).toBeLeftOf("invalid_usage_data")
    expect(await redisClient.hgetall(key)).toEqual(before)
  })

  it("rejects settlement overflow before releasing the hold or changing replay markers", async () => {
    // Given
    const key = `${redisPrefix}settlement-overflow`
    const owner = uuidv7()
    const operationId = uuidv7()
    const snapshotResult = UsageSnapshotFactory.validate({
      consumed: 9223372036854775806n,
      operations: [{operationId, estimatedUnits: 1n, state: "reserved", expiresAt: operationExpiresAt}]
    })
    const snapshot = unwrapRight(snapshotResult)
    const claim = await admissionClient.beginRebuild(key, owner)()
    unwrapRight(claim)
    const restored = await restoreCache(key, owner, snapshot, new Date(Date.now() + 60_000))()
    unwrapRight(restored)
    const settlementResult = UsageSettlementResultFactory.validate({state: "settled", actualUnits: 2n})
    const settlement = unwrapRight(settlementResult)
    const before = await redisClient.hgetall(key)
    // When
    const result = await applySettlement(key, operationId, 1n, settlement)()
    // Expect
    expect(result).toBeLeftOf("invalid_usage_data")
    expect(await redisClient.hgetall(key)).toEqual(before)
  })

  describe("high concurrency testing", () => {
    it("should enforce zero race condition over-allocations under 50 parallel requests", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await restoreCache(
          key,
          owner,
          unwrapRight(UsageSnapshotFactory.validate({consumed: 0n, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 300n
      const estimatePerReq = 10n
      const totalRequests = 50

      // When: Execute 50 parallel reservation requests concurrently
      const promises = Array.from({length: totalRequests}, () =>
        reserveOperation(key, uuidv7(), limit, estimatePerReq)()
      )
      const results = await Promise.all(promises)
      const allowedRequests = results.filter(E.isRight)
      const rejectedRequests = results.filter(E.isLeft)
      const finalUsage = await admissionClient.getUsage(key)()

      // Expect: With limit=300 and estimate=10, exactly 30 requests should be allowed
      expect(allowedRequests).toHaveLength(30)
      expect(rejectedRequests).toHaveLength(20)
      expect(finalUsage).toBeRightOf({consumed: 0n, reserved: 300n})
    })
  })
})
