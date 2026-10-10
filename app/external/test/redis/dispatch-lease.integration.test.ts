import {Test, TestingModule} from "@nestjs/testing"
import {ConfigModule, RedisClient, RedisDispatchLeaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {randomOrgId} from "@test/organization-id"
import {cleanRedisByPrefix, prepareRedisPrefix} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {unwrapRight} from "@utils/either"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"

describe("Redis dispatch concurrency leases", () => {
  let module: TestingModule
  let redis: RedisClient
  let leases: RedisDispatchLeaseClient
  let prefix: string
  const context = {organizationId: randomOrgId()}
  const expiryKey = () => `${prefix}dispatch:{${context.organizationId}}:expiry`

  beforeAll(async () => {
    prefix = prepareRedisPrefix()
    const config = MockConfigProvider.fromOriginalProvider({redisPrefix: prefix})
    module = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [RedisClient, RedisDispatchLeaseClient]
    })
      .overrideProvider(ConfigProvider)
      .useValue(config)
      .compile()
    await module.init()
    redis = module.get(RedisClient)
    leases = module.get(RedisDispatchLeaseClient)
  }, 30000)
  afterEach(async () => {
    await cleanRedisByPrefix(prefix)
  })
  afterAll(async () => {
    await module.close()
  })

  it("atomically admits four dispatches from a simultaneous burst and leaves another organization free", async () => {
    // Given
    const tasks = Array.from({length: 10}, () => uuidv7())
    // When
    const results = await Promise.all(tasks.map(taskId => leases.acquire(context, taskId, uuidv7())()))
    const other = await leases.acquire({organizationId: randomOrgId()}, uuidv7(), uuidv7())()
    // Expect
    expect(results.filter(E.isRight)).toHaveLength(4)
    expect(results.filter(E.isLeft).map(result => result.left)).toEqual(Array(6).fill("capacity_exceeded"))
    expect(unwrapRight(other).fencing).toBe(1n)
    expect(await redis.zcard(expiryKey())).toBe(4)
  })

  it("reacquires the same live owner without consuming another slot or changing its generation", async () => {
    // Given
    const taskId = uuidv7()
    const owner = uuidv7()
    const initial = unwrapRight(await leases.acquire(context, taskId, owner)())
    // When
    const duplicate = unwrapRight(await leases.acquire(context, taskId, owner)())
    const competitor = await leases.acquire(context, taskId, uuidv7())()
    // Expect
    expect(duplicate).toEqual(initial)
    expect(competitor).toEqual(E.left("lease_lost"))
    expect(await redis.zcard(expiryKey())).toBe(1)
  })

  it("checks the current holder without extending capacity expiry", async () => {
    // Given
    const taskId = uuidv7()
    const lease = unwrapRight(await leases.acquire(context, taskId, uuidv7())())
    const shortenedExpiry = Date.now() + 10000
    await redis.zadd(expiryKey(), shortenedExpiry, taskId)

    // When
    expect(await leases.assertLease(context, taskId, lease)()).toEqual(E.right(undefined))

    // Expect
    expect(Number(await redis.zscore(expiryKey(), taskId))).toBe(shortenedExpiry)
    expect(await redis.zcard(expiryKey())).toBe(1)
  })

  it("reclaims expired capacity with a new generation and rejects the previous holder", async () => {
    // Given
    const taskId = uuidv7()
    const previous = unwrapRight(await leases.acquire(context, taskId, uuidv7())())
    await redis.zadd(expiryKey(), 0, taskId)
    expect(await leases.assertLease(context, taskId, previous)()).toEqual(E.left("lease_lost"))
    // When
    const current = unwrapRight(await leases.acquire(context, taskId, uuidv7())())
    const staleRelease = await leases.release(context, taskId, previous)()
    // Expect
    expect(current.fencing).toBeGreaterThan(previous.fencing)
    expect(staleRelease).toEqual(E.left("lease_lost"))
    expect(await redis.zcard(expiryKey())).toBe(1)
    expect(await leases.assertLease(context, taskId, current)()).toEqual(E.right(undefined))
  })

  it("releases the current holder idempotently and admits a previously blocked dispatch", async () => {
    // Given
    const held = await Promise.all(
      Array.from({length: 4}, async () => {
        const taskId = uuidv7()
        return {taskId, lease: unwrapRight(await leases.acquire(context, taskId, uuidv7())())}
      })
    )
    const nextTask = uuidv7()
    const owner = uuidv7()
    expect(await leases.acquire(context, nextTask, owner)()).toEqual(E.left("capacity_exceeded"))
    const first = held[0]!
    // When
    const released = await leases.release(context, first.taskId, first.lease)()
    const repeated = await leases.release(context, first.taskId, first.lease)()
    const admitted = await leases.acquire(context, nextTask, owner)()
    // Expect
    expect(released).toEqual(E.right(undefined))
    expect(repeated).toEqual(E.right(undefined))
    expect(unwrapRight(admitted).owner).toBe(owner)
    expect(await redis.zcard(expiryKey())).toBe(4)
  })

  it("does not let a lease from lost Redis state release a new holder with a reset counter", async () => {
    // Given: erase only this test organization's three keys to reproduce loss of lease storage.
    const taskId = uuidv7()
    const previous = unwrapRight(await leases.acquire(context, taskId, uuidv7())())
    await redis.del(
      expiryKey(),
      `${prefix}dispatch:{${context.organizationId}}:holders`,
      `${prefix}dispatch:{${context.organizationId}}:fencing`
    )
    // When: a new attempt has a different immutable owner token even if its Redis counter restarts.
    const current = unwrapRight(await leases.acquire(context, taskId, uuidv7())())
    // Expect
    expect(current.fencing).toBe(previous.fencing)
    expect(await leases.release(context, taskId, previous)()).toEqual(E.left("lease_lost"))
    expect(await leases.assertLease(context, taskId, previous)()).toEqual(E.left("lease_lost"))
    expect(await leases.assertLease(context, taskId, current)()).toEqual(E.right(undefined))
  })

  it("fails closed when Redis is disconnected without enqueueing an offline command", async () => {
    // Given
    await new Promise<void>(resolve => {
      redis.once("end", resolve)
      redis.disconnect()
    })
    try {
      // When
      const result = await leases.acquire(context, uuidv7(), uuidv7())()
      // Expect
      expect(result).toEqual(E.left("repository_dependency_error"))
    } finally {
      await redis.connect()
    }
  })
})
