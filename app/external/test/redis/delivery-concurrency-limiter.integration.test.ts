import {Test, TestingModule} from "@nestjs/testing"
import {ConfigModule, RedisClient, RedisDeliveryConcurrencyLimiter} from "@external"
import {ConfigProvider} from "@external/config"
import {DeliveryPermitFactory} from "@domain"
import {randomOrgId} from "@test/organization-id"
import {cleanRedisByPrefix, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"
import {v7 as uuidv7} from "uuid"

describe("Redis delivery concurrency limiter", () => {
  let module: TestingModule
  let redis: RedisClient
  let limiter: RedisDeliveryConcurrencyLimiter
  let prefix: string
  const context = {organizationId: randomOrgId()}
  const expiryKey = () => `${prefix}dispatch:{${context.organizationId}}:expiry`
  const holdersKey = () => `${prefix}dispatch:{${context.organizationId}}:holders`

  beforeAll(async () => {
    prefix = prepareRedisPrefix()
    const config = MockConfigProvider.fromOriginalProvider({redisPrefix: prefix})
    module = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [RedisClient, RedisDeliveryConcurrencyLimiter]
    })
      .overrideProvider(ConfigProvider)
      .useValue(config)
      .compile()
    await module.init()
    redis = module.get(RedisClient)
    limiter = module.get(RedisDeliveryConcurrencyLimiter)
  }, 30000)

  afterEach(async () => {
    await cleanRedisByPrefix(prefix)
  })

  afterAll(async () => {
    await module.close()
  })

  it("reuses a live permit for the same owner and rejects a competing owner for the same task", async () => {
    // Given: one execution already owns an unexpired permit for this task.
    const taskId = uuidv7()
    const owner = uuidv7()
    const initial = unwrapRight(await limiter.acquirePermit(context, taskId, owner)())

    // When: that execution retries acquisition with the same owner token.
    const duplicate = await limiter.acquirePermit(context, taskId, owner)()

    // Expect: acquisition is idempotent for the existing owner.
    expect(duplicate).toBeRightOf(initial)

    // When: a different execution tries to acquire the same task before the permit expires.
    const competitor = await limiter.acquirePermit(context, taskId, uuidv7())()

    // Expect: another execution already owns this task's live permit, so competing dispatch is denied.
    expect(competitor).toBeLeftOf("delivery_permit_held_by_another_owner")
  })

  it("checks the current holder without extending limiter expiry", async () => {
    // Given
    const taskId = uuidv7()
    const lease = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
    const shortenedExpiry = Date.now() + 10000
    await redis.zadd(expiryKey(), shortenedExpiry, taskId)

    // When
    const result = await limiter.validatePermit(context, taskId, lease)()

    // Expect: ownership validation succeeds without renewing the stored expiry.
    expect(result).toBeRightOf(undefined)
    expect(Number(await redis.zscore(expiryKey(), taskId))).toBe(shortenedExpiry)
  })

  it("reclaims expired limiter with a new generation and rejects the previous holder", async () => {
    // Given
    const taskId = uuidv7()
    const previous = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
    await redis.zadd(expiryKey(), 0, taskId)

    // When: the expired holder checks ownership.
    const expired = await limiter.validatePermit(context, taskId, previous)()

    // Expect: an expired permit no longer authorizes the previous execution.
    expect(expired).toBeLeftOf("lease_lost")

    // When: another owner reclaims the expired slot.
    const acquisition = await limiter.acquirePermit(context, taskId, uuidv7())()

    // Expect: reclaiming the slot succeeds with a generation newer than the expired permit.
    expect(acquisition).toBeRight()
    const current = unwrapRight(acquisition)
    expect(current.fencing).toBeGreaterThan(previous.fencing)

    // When: the previous owner attempts cleanup.
    const staleRelease = await limiter.releasePermit(context, taskId, previous)()

    // Expect: the stale owner cannot release the replacement permit.
    expect(staleRelease).toBeLeftOf("lease_lost")

    // When: the replacement checks ownership after the stale cleanup attempt.
    const validation = await limiter.validatePermit(context, taskId, current)()

    // Expect: the replacement remains authorized after the stale release attempt.
    expect(validation).toBeRightOf(undefined)
  })

  it("removes both holder fields when reclaiming an expired task's slot", async () => {
    // Given
    const expiredTaskId = uuidv7()
    unwrapRight(await limiter.acquirePermit(context, expiredTaskId, uuidv7())())
    await redis.zadd(expiryKey(), 0, expiredTaskId)

    // When: a new task acquires a slot, triggering expired-holder cleanup.
    const result = await limiter.acquirePermit(context, uuidv7(), uuidv7())()

    // Expect: acquisition succeeds and both fields belonging to the expired holder are removed.
    expect(result).toBeRight()
    expect(await redis.hmget(holdersKey(), `${expiredTaskId}:owner`, `${expiredTaskId}:fencing`)).toEqual([null, null])
  })

  it("rejects an incorrect generation even when the owner matches", async () => {
    // Given
    const taskId = uuidv7()
    const current = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
    const wrongGeneration = unwrapRight(DeliveryPermitFactory.validate({...current, fencing: current.fencing + 1n}))

    // When
    const validation = await limiter.validatePermit(context, taskId, wrongGeneration)()

    // Expect: a matching owner cannot authorize a permit with the wrong generation.
    expect(validation).toBeLeftOf("lease_lost")

    // When: the incorrect generation attempts release.
    const release = await limiter.releasePermit(context, taskId, wrongGeneration)()

    // Expect: the incorrect generation cannot release the current permit.
    expect(release).toBeLeftOf("lease_lost")

    // When: the current generation checks ownership.
    const currentValidation = await limiter.validatePermit(context, taskId, current)()

    // Expect: the legitimate permit remains valid after the rejected operations.
    expect(currentValidation).toBeRightOf(undefined)
  })

  it("keeps large generation values exact through acquisition, validation and release", async () => {
    // Given
    await redis.set(`${prefix}dispatch:{${context.organizationId}}:fencing`, "9007199254740992")
    const taskId = uuidv7()

    // When
    const acquisition = await limiter.acquirePermit(context, taskId, uuidv7())()

    // Expect: acquisition preserves the exact integer above JavaScript number precision.
    expect(acquisition).toBeRight()
    const current = unwrapRight(acquisition)
    expect(current.fencing).toBe(9007199254740993n)

    // When: the acquired generation is used for validation.
    const validation = await limiter.validatePermit(context, taskId, current)()

    // Expect: validation accepts the exact large generation returned by acquisition.
    expect(validation).toBeRightOf(undefined)

    // When: the same generation is used for release.
    const release = await limiter.releasePermit(context, taskId, current)()

    // Expect: release accepts that same large generation without rounding it.
    expect(release).toBeRightOf(undefined)
  })

  it.each(["owner", "fencing"])("denies operations on a holder missing its %s field", async field => {
    // Given
    const taskId = uuidv7()
    const current = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
    await redis.hdel(holdersKey(), `${taskId}:${field}`)

    // When
    const reacquisition = await limiter.acquirePermit(context, taskId, current.owner)()

    // Expect: partial holder data is reported as inconsistent state during acquisition.
    expect(reacquisition).toBeLeftOf("delivery_permit_state_inconsistent")

    // When: the holder attempts validation with incomplete stored ownership.
    const validation = await limiter.validatePermit(context, taskId, current)()

    // Expect: validation reports inconsistent state instead of treating corruption as lease loss.
    expect(validation).toBeLeftOf("delivery_permit_state_inconsistent")

    // When: the holder attempts release with incomplete stored ownership.
    const release = await limiter.releasePermit(context, taskId, current)()

    // Expect: release reports inconsistent state instead of treating corruption as lease loss.
    expect(release).toBeLeftOf("delivery_permit_state_inconsistent")
  })

  it("releases the permit and accepts repeated cleanup", async () => {
    // Given
    const taskId = uuidv7()
    const permit = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())

    // When
    const released = await limiter.releasePermit(context, taskId, permit)()

    // Expect: releasing the current permit succeeds.
    expect(released).toBeRightOf(undefined)

    // When: the released permit is used to check ownership.
    const validation = await limiter.validatePermit(context, taskId, permit)()

    // Expect: the released permit no longer authorizes delivery.
    expect(validation).toBeLeftOf("lease_lost")

    // When: cleanup is repeated after the holder has been removed.
    const repeated = await limiter.releasePermit(context, taskId, permit)()

    // Expect: repeated cleanup succeeds even though the permit is already gone.
    expect(repeated).toBeRightOf(undefined)
  })

  it("does not let a lease from lost Redis state release a new holder with a reset counter", async () => {
    // Given: erase only this test organization's three keys to reproduce loss of lease storage.
    const taskId = uuidv7()
    const previous = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
    await redis.del(
      expiryKey(),
      `${prefix}dispatch:{${context.organizationId}}:holders`,
      `${prefix}dispatch:{${context.organizationId}}:fencing`
    )

    // When: a new attempt has a different immutable owner token even if its Redis counter restarts.
    const acquisition = await limiter.acquirePermit(context, taskId, uuidv7())()

    // Expect: acquisition succeeds even though state loss has reset the generation counter.
    expect(acquisition).toBeRight()
    const current = unwrapRight(acquisition)
    expect(current.fencing).toBe(previous.fencing)

    // When: the old holder attempts release despite its matching generation.
    const release = await limiter.releasePermit(context, taskId, previous)()

    // Expect: a matching generation cannot let the old owner release the new owner's permit.
    expect(release).toBeLeftOf("lease_lost")

    // When: the old holder checks ownership.
    const staleValidation = await limiter.validatePermit(context, taskId, previous)()

    // Expect: the old owner remains unauthorized despite the matching generation.
    expect(staleValidation).toBeLeftOf("lease_lost")

    // When: the replacement holder checks ownership after both stale operations.
    const validation = await limiter.validatePermit(context, taskId, current)()

    // Expect: the replacement remains authorized after both stale operations.
    expect(validation).toBeRightOf(undefined)
  })

  describe("when Redis is disconnected", () => {
    afterEach(async () => {
      await redis.connect()
    })

    it("fails closed when Redis is disconnected without enqueueing an offline command", async () => {
      // Given: a real permit exists before Redis becomes unavailable.
      const taskId = uuidv7()
      const permit = unwrapRight(await limiter.acquirePermit(context, taskId, uuidv7())())
      await new Promise<void>(resolve => {
        redis.once("end", resolve)
        redis.disconnect()
      })

      // When
      const acquisition = await limiter.acquirePermit(context, uuidv7(), uuidv7())()

      // Expect: acquisition reports Redis unavailability instead of granting a permit.
      expect(acquisition).toBeLeftOf("repository_dependency_error")

      // When: an existing holder attempts validation while disconnected.
      const validation = await limiter.validatePermit(context, taskId, permit)()

      // Expect: validation reports Redis unavailability instead of authorizing delivery.
      expect(validation).toBeLeftOf("repository_dependency_error")

      // When: the holder attempts cleanup while disconnected.
      const release = await limiter.releasePermit(context, taskId, permit)()

      // Expect: release reports Redis unavailability instead of claiming cleanup succeeded.
      expect(release).toBeLeftOf("repository_dependency_error")
    })
  })
})
