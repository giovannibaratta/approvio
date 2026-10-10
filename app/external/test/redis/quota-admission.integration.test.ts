import {UsageSettlementResultFactory} from "@services/durable-work/models"
import {UsageCacheSnapshotFactory} from "@services/durable-work/models"
import {ConfigModule, RedisClient, RedisQuotaAdmissionClient, buildQuotaUsageKey} from "@external"
import {ConfigProvider} from "@external/config"
import {Test, TestingModule} from "@nestjs/testing"
import * as E from "fp-ts/Either"
import {cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("RedisQuotaAdmissionClient Integration", () => {
  let admissionClient: RedisQuotaAdmissionClient
  let redisClient: RedisClient
  let redisPrefix: string

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
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 1000
      const firstOperation = uuidv7()
      const secondOperation = uuidv7()

      // When: Initial reservation
      const reserveRes1 = unwrapRight(await admissionClient.reserveOperation(key, firstOperation, limit, 100)())

      // Expect
      expect(reserveRes1).toEqual({
        consumed: 0,
        reserved: 100
      })

      // When: Check usage after reservation
      const usage1 = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage1).toEqual({consumed: 0, reserved: 100})

      // When: Settle with estimate 100 and actual 80
      const settledConsumed = unwrapRight(
        await admissionClient.applySettlement(
          key,
          firstOperation,
          "1",
          100,
          unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 80}))
        )()
      )

      // Expect
      expect(settledConsumed).toBe(80)

      // When: Check usage after settlement
      const usage2 = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage2).toEqual({consumed: 80, reserved: 0})

      // When: Second reservation with current consumed = 80
      const reserveRes2 = unwrapRight(await admissionClient.reserveOperation(key, secondOperation, limit, 200)())

      // Expect
      expect(reserveRes2).toEqual({
        consumed: 80,
        reserved: 200
      })

      // When: Check usage after second reservation
      const usage3 = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage3).toEqual({consumed: 80, reserved: 200})
    })
  })

  describe("limit enforcement", () => {
    it("should reject reservation when limit would be exceeded", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 100

      // When: Reserve 80 out of 100
      const res1 = unwrapRight(await admissionClient.reserveOperation(key, uuidv7(), limit, 80)())

      // Expect
      expect(res1).toEqual({consumed: 0, reserved: 80})

      // When: Attempt to reserve 30 (80 + 30 = 110 > 100) -> should be rejected
      const res2 = await admissionClient.reserveOperation(key, uuidv7(), limit, 30)()

      // Expect
      expect(res2).toEqual(E.left("quota_exceeded"))

      // When: Check usage to ensure hash state was preserved
      const usage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage).toEqual({consumed: 0, reserved: 80})
    })

    it("should allow unlimited mode when limit is UNLIMITED", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = "UNLIMITED"

      // When
      const res = unwrapRight(await admissionClient.reserveOperation(key, uuidv7(), limit, 1_000_000)())

      // Expect
      expect(res).toEqual({
        consumed: 0,
        reserved: 1_000_000
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
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 500

      // When: Reserve capacity
      const operationId = uuidv7()
      const res1 = unwrapRight(await admissionClient.reserveOperation(key, operationId, limit, 150)())

      // Expect
      expect(res1.reserved).toBe(150)

      // When: Release reserved capacity
      unwrapRight(
        await admissionClient.applySettlement(
          key,
          operationId,
          "1",
          150,
          unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))
        )()
      )
      const usage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect: Verify reserved capacity is 0
      expect(usage).toEqual({consumed: 0, reserved: 0})
    })
  })

  describe("operation settlement idempotency", () => {
    it("applies a durable operation reservation and settlement once", async () => {
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const operationId = "019a1234-5678-7abc-8def-0123456789ab"

      const first = unwrapRight(await admissionClient.reserveOperation(key, operationId, 100, 80)())
      const duplicate = unwrapRight(await admissionClient.reserveOperation(key, operationId, 100, 80)())
      expect(first).toEqual({consumed: 0, reserved: 80})
      expect(duplicate).toEqual(first)

      unwrapRight(
        await admissionClient.applySettlement(
          key,
          operationId,
          "1",
          80,
          unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 70}))
        )()
      )
      unwrapRight(
        await admissionClient.applySettlement(
          key,
          operationId,
          "1",
          80,
          unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 70}))
        )()
      )
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70, reserved: 0})

      expect(
        await admissionClient.applySettlement(
          key,
          operationId,
          "1",
          80,
          unwrapRight(UsageSettlementResultFactory.validate({state: "settled", actualUnits: 71}))
        )()
      ).toEqual(E.left({type: "operation_mismatch"}))
    })
  })

  describe("recovery fencing and retention", () => {
    it("rejects missing-cache admission and stale rebuild owners", async () => {
      const key = `${redisPrefix}recovery`
      const oldOwner = uuidv7()
      const newOwner = uuidv7()
      const operationId = uuidv7()
      expect(await admissionClient.reserveOperation(key, operationId, 100, 40)()).toEqual(
        E.left({type: "cache_unavailable"})
      )
      expect(await admissionClient.getUsage(key)()).toEqual(E.left({type: "cache_unavailable"}))
      expect(unwrapRight(await admissionClient.beginRebuild(key, oldOwner)())).toBe("claimed")
      expect(unwrapRight(await admissionClient.beginRebuild(key, newOwner)())).toBe("busy")
      await redisClient.hset(key, "rebuildUntil", "0")
      expect(unwrapRight(await admissionClient.beginRebuild(key, newOwner)())).toBe("claimed")
      const snapshot = unwrapRight(
        UsageCacheSnapshotFactory.validate({
          consumed: 70,
          operations: [{operationId, estimatedUnits: 40, revision: "0", state: "reserved" as const}]
        })
      )
      expect(await admissionClient.restore(key, oldOwner, snapshot, new Date(0))()).toEqual(
        E.left({type: "cache_unavailable"})
      )
      unwrapRight(await admissionClient.restore(key, newOwner, snapshot, new Date(0))())
      expect(await admissionClient.reserveOperation(key, operationId, 100, 40)()).toEqual(E.left("quota_exceeded"))
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70, reserved: 40})
      expect(await redisClient.ttl(key)).toBe(-1)
      unwrapRight(
        await admissionClient.applySettlement(
          key,
          operationId,
          "1",
          40,
          unwrapRight(UsageSettlementResultFactory.validate({state: "cancelled"}))
        )()
      )
      expect(await redisClient.ttl(key)).toBeGreaterThan(0)
      expect(unwrapRight(await admissionClient.getUsage(key)())).toEqual({consumed: 70, reserved: 0})
    })
  })

  describe("high concurrency testing", () => {
    it("should enforce zero race condition over-allocations under 50 parallel requests", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const owner = uuidv7()
      expect(unwrapRight(await admissionClient.beginRebuild(key, owner)())).toBe("claimed")
      unwrapRight(
        await admissionClient.restore(
          key,
          owner,
          unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 0, operations: []})),
          new Date(Date.now() + 86400000)
        )()
      )
      const limit = 300
      const estimatePerReq = 10
      const totalRequests = 50

      // When: Execute 50 parallel reservation requests concurrently
      const promises = Array.from({length: totalRequests}, () =>
        admissionClient.reserveOperation(key, uuidv7(), limit, estimatePerReq)()
      )
      const results = await Promise.all(promises)
      const allowedRequests = results.filter(E.isRight)
      const rejectedRequests = results.filter(E.isLeft)
      const finalUsage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect: With limit=300 and estimate=10, exactly 30 requests should be allowed
      expect(allowedRequests).toHaveLength(30)
      expect(rejectedRequests).toHaveLength(20)
      expect(finalUsage.consumed).toBe(0)
      expect(finalUsage.reserved).toBe(300)
    })
  })
})
