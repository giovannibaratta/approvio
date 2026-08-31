import {Inject, Injectable} from "@nestjs/common"
import {QuotaAdmissionClient, RedisError, ReservationResult} from "@services/usage-metering"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {RedisClient} from "./redis-client"

export {QuotaAdmissionClient, RedisError, ReservationResult}

interface QuotaAdmissionCommands {
  reserveQuota(key: string, limit: number, estimate: number, ttl: number): Promise<unknown>
  settleQuota(key: string, estimate: number, actual: number): Promise<unknown>
  releaseQuota(key: string, estimate: number): Promise<unknown>
}

export type QuotaAdmissionRedisClient = RedisClient & QuotaAdmissionCommands

/**
 * Lua Script: reserve.lua
 *
 * Atomically evaluates pre-flight quota admission and holds capacity reservations in Redis.
 *
 * Keys & Parameters:
 * - KEYS[1]: Redis Hash key formatted as "usage:{orgId}:{metric}:{billingPeriodId}"
 * - ARGV[1]: limit (number, -1 signifies an unlimited quota)
 * - ARGV[2]: estimate (number, expected consumption units to reserve inflight)
 * - ARGV[3]: ttl (number in seconds, expiration window for the key)
 *
 * Behavior & Resilience Rules:
 * 1. Reads 'consumed' and 'reserved' hash fields. If fields are missing or non-numeric (e.g. key expired),
 *    tonumber(...) returns nil, cleanly defaulting to 0 via 'or 0'.
 * 2. Key Expiration / Cold Cache: If a key expired or Redis restarted, consumption defaults to 0 in Redis.
 *    Reconciliation and population against durable PostgreSQL event usage is performed asynchronously
 *    by the higher-level Service Layer.
 * 3. Out-of-Order Releases: math.max(0, ...) prevents negative reserved values caused by out-of-order network retries.
 * 4. Limits: If limit != -1 and (consumed + reserved + estimate) > limit, rejects reservation returning {0, consumed, reserved}.
 * 5. Success: Otherwise, increments 'reserved' by estimate, sets TTL, and returns {1, consumed, reserved + estimate}.
 *
 * Return Array Format: [allowed (0|1), current_consumed (number), current_reserved (number)]
 */
const RESERVE_LUA = `
local limit = tonumber(ARGV[1])
local estimate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local consumed = tonumber(redis.call('HGET', KEYS[1], 'consumed')) or 0
local reserved = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'reserved')) or 0)

if limit ~= -1 and (consumed + reserved + estimate) > limit then
  return {0, consumed, reserved}
end

redis.call('HINCRBY', KEYS[1], 'reserved', estimate)
redis.call('EXPIRE', KEYS[1], ttl)
return {1, consumed, reserved + estimate}
`

/**
 * Lua Script: settle.lua
 *
 * Atomically transitions an inflight reservation into settled consumption upon task completion.
 *
 * Keys & Parameters:
 * - KEYS[1]: Redis Hash key ("usage:{orgId}:{metric}:{billingPeriodId}")
 * - ARGV[1]: estimate (number, estimated capacity previously reserved)
 * - ARGV[2]: actual (number, actual capacity consumed by the completed invocation)
 *
 * Returns:
 * - current_consumed (number, total settled consumption in the active period)
 */
const SETTLE_LUA = `
local estimate = tonumber(ARGV[1])
local actual = tonumber(ARGV[2])

redis.call('HINCRBY', KEYS[1], 'reserved', -estimate)
redis.call('HINCRBY', KEYS[1], 'consumed', actual)

local current_consumed = tonumber(redis.call('HGET', KEYS[1], 'consumed')) or 0
return current_consumed
`

/**
 * Lua Script: release.lua
 *
 * Atomically releases an inflight reservation following a execution failure or cancellation.
 *
 * Keys & Parameters:
 * - KEYS[1]: Redis Hash key ("usage:{orgId}:{metric}:{billingPeriodId}")
 * - ARGV[1]: estimate (number, estimated capacity to deduct from reserved inflight)
 *
 * Returns:
 * - 1 (number)
 */
const RELEASE_LUA = `
local estimate = tonumber(ARGV[1])
redis.call('HINCRBY', KEYS[1], 'reserved', -estimate)
return 1
`

export function buildQuotaUsageKey(orgId: string, metric: string, billingPeriodId: string): string {
  return `usage:${orgId}:${metric}:${billingPeriodId}`
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

@Injectable()
export class RedisQuotaAdmissionClient implements QuotaAdmissionClient {
  constructor(@Inject(RedisClient) private readonly redis: QuotaAdmissionRedisClient) {
    this.defineCommands()
  }

  private defineCommands(): void {
    this.redis.defineCommand("reserveQuota", {
      numberOfKeys: 1,
      lua: RESERVE_LUA
    })
    this.redis.defineCommand("settleQuota", {
      numberOfKeys: 1,
      lua: SETTLE_LUA
    })
    this.redis.defineCommand("releaseQuota", {
      numberOfKeys: 1,
      lua: RELEASE_LUA
    })
  }

  reserve(
    key: string,
    limit: number,
    estimate: number,
    ttlSeconds: number = DEFAULT_TTL_SECONDS
  ): TE.TaskEither<RedisError, ReservationResult> {
    return pipe(
      TE.tryCatch(
        async () => {
          const res = await this.redis.reserveQuota(key, limit, estimate, ttlSeconds)
          return res
        },
        (error): RedisError => ({type: "redis_error", error})
      ),
      TE.chain(res => {
        if (!Array.isArray(res) || res.length < 3) return TE.left<RedisError>({type: "invalid_response", error: res})
        return TE.right({
          allowed: Number(res[0]) === 1,
          consumed: Number(res[1]),
          reserved: Number(res[2])
        })
      })
    )
  }

  settle(key: string, estimate: number, actual: number): TE.TaskEither<RedisError, number> {
    return TE.tryCatch(
      async () => {
        const res = await this.redis.settleQuota(key, estimate, actual)
        return Number(res)
      },
      (error): RedisError => ({type: "redis_error", error})
    )
  }

  release(key: string, estimate: number): TE.TaskEither<RedisError, void> {
    return TE.tryCatch(
      async () => {
        await this.redis.releaseQuota(key, estimate)
      },
      (error): RedisError => ({type: "redis_error", error})
    )
  }

  getUsage(key: string): TE.TaskEither<RedisError, {consumed: number; reserved: number}> {
    return TE.tryCatch(
      async () => {
        const [consumedStr, reservedStr] = await this.redis.hmget(key, "consumed", "reserved")
        return {
          consumed: parseInt(consumedStr ?? "0", 10) || 0,
          reserved: parseInt(reservedStr ?? "0", 10) || 0
        }
      },
      (error): RedisError => ({type: "redis_error", error})
    )
  }
}
