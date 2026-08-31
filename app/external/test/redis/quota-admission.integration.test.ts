import {ConfigModule, RedisClient, RedisQuotaAdmissionClient, buildQuotaUsageKey} from "@external"
import {ConfigProvider} from "@external/config"
import {Test, TestingModule} from "@nestjs/testing"
import {ReservationResult} from "@services/usage-metering"
import {cleanRedisByPrefix, prepareDatabase, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"

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
          dbConnectionUrl: isolatedDb,
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
      const limit = 1000

      // When: Initial reservation
      const reserveRes1 = unwrapRight(await admissionClient.reserve(key, limit, 100)())

      // Expect
      expect(reserveRes1).toEqual({
        allowed: true,
        consumed: 0,
        reserved: 100
      })

      // When: Check usage after reservation
      const usage1 = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage1).toEqual({consumed: 0, reserved: 100})

      // When: Settle with estimate 100 and actual 80
      const settledConsumed = unwrapRight(await admissionClient.settle(key, 100, 80)())

      // Expect
      expect(settledConsumed).toBe(80)

      // When: Check usage after settlement
      const usage2 = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage2).toEqual({consumed: 80, reserved: 0})

      // When: Second reservation with current consumed = 80
      const reserveRes2 = unwrapRight(await admissionClient.reserve(key, limit, 200)())

      // Expect
      expect(reserveRes2).toEqual({
        allowed: true,
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
      const limit = 100

      // When: Reserve 80 out of 100
      const res1 = unwrapRight(await admissionClient.reserve(key, limit, 80)())

      // Expect
      expect(res1.allowed).toBe(true)

      // When: Attempt to reserve 30 (80 + 30 = 110 > 100) -> should be rejected
      const res2 = unwrapRight(await admissionClient.reserve(key, limit, 30)())

      // Expect
      expect(res2).toEqual({
        allowed: false,
        consumed: 0,
        reserved: 80
      })

      // When: Check usage to ensure hash state was preserved
      const usage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect
      expect(usage).toEqual({consumed: 0, reserved: 80})
    })

    it("should allow unlimited mode when limit is -1", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const limit = -1

      // When
      const res = unwrapRight(await admissionClient.reserve(key, limit, 1_000_000)())

      // Expect
      expect(res).toEqual({
        allowed: true,
        consumed: 0,
        reserved: 1_000_000
      })
    })
  })

  describe("release", () => {
    it("should release reserved capacity after operation failure", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const limit = 500

      // When: Reserve capacity
      const res1 = unwrapRight(await admissionClient.reserve(key, limit, 150)())

      // Expect
      expect(res1.reserved).toBe(150)

      // When: Release reserved capacity
      unwrapRight(await admissionClient.release(key, 150)())
      const usage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect: Verify reserved capacity is 0
      expect(usage).toEqual({consumed: 0, reserved: 0})
    })
  })

  describe("high concurrency testing", () => {
    it("should enforce zero race condition over-allocations under 50 parallel requests", async () => {
      // Given
      const key = `${redisPrefix}usage:org1:metric1:2025-05`
      const limit = 300
      const estimatePerReq = 10
      const totalRequests = 50

      // When: Execute 50 parallel reservation requests concurrently
      const promises = Array.from({length: totalRequests}, () => admissionClient.reserve(key, limit, estimatePerReq)())
      const results = await Promise.all(promises)
      const unwrappedResults: ReservationResult[] = results.map(unwrapRight)
      const allowedRequests = unwrappedResults.filter(r => r.allowed)
      const rejectedRequests = unwrappedResults.filter(r => !r.allowed)
      const finalUsage = unwrapRight(await admissionClient.getUsage(key)())

      // Expect: With limit=300 and estimate=10, exactly 30 requests should be allowed
      expect(allowedRequests).toHaveLength(30)
      expect(rejectedRequests).toHaveLength(20)
      expect(finalUsage.consumed).toBe(0)
      expect(finalUsage.reserved).toBe(300)
    })
  })
})
