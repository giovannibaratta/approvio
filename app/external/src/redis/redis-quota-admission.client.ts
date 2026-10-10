import {TierQuotaLimit, UNLIMITED_QUOTA_SENTINEL} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {QuotaAdmissionClient, QuotaAdmissionError, ReservationResult} from "@services/usage-metering"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {UsageCacheSnapshot, UsageSettlementResult} from "@services/durable-work/interfaces"
import {RedisClient} from "./redis-client"

interface QuotaAdmissionCommands {
  beginQuotaRebuild(key: string, owner: string): Promise<unknown>
  restoreQuotaCache(key: string, owner: string, snapshot: string, retainUntil: number): Promise<unknown>
  reserveQuota(key: string, operationId: string, limit: number, estimate: number): Promise<unknown>
  settleQuota(
    key: string,
    operationId: string,
    revision: string,
    estimate: number,
    state: string,
    actual: number
  ): Promise<unknown>
}

export type QuotaAdmissionRedisClient = RedisClient & QuotaAdmissionCommands

/**
 * Claims one usage hash for rebuilding, or reports ready/busy.
 * KEYS[1]: usage:{orgId}:{metric}:{billingPeriodId}; ARGV[1]: owner token.
 * Redis time bounds the lease to 60 seconds without relying on worker clocks.
 */
const BEGIN_REBUILD_LUA = `
if redis.call('HGET', KEYS[1], 'ready') == '1' then return 'ready' end
local now = tonumber(redis.call('TIME')[1])
local untilTime = tonumber(redis.call('HGET', KEYS[1], 'rebuildUntil')) or 0
if untilTime > now then return 'busy' end
redis.call('HSET', KEYS[1], 'rebuildOwner', ARGV[1], 'rebuildUntil', now + 60)
return 'claimed'
`

/**
 * Publishes totals and replay markers atomically under an unexpired owner token.
 * ARGV: owner, JSON UsageCacheSnapshot, terminal retention timestamp (seconds).
 * Returns ok/unavailable. Live reservations keep the hash from expiring.
 * A recovered hold must pass admission again because durable reservation precedes Redis admission.
 */
const RESTORE_CACHE_LUA = `
local now = tonumber(redis.call('TIME')[1])
if redis.call('HGET', KEYS[1], 'rebuildOwner') ~= ARGV[1] or
   tonumber(redis.call('HGET', KEYS[1], 'rebuildUntil') or '0') <= now then return 'unavailable' end
local snapshot = cjson.decode(ARGV[2])
local reserved = 0
local fields = {}
for _, operation in ipairs(snapshot.operations) do
  local state = operation.state
  local actual = '-'
  if state == 'reserved' then
    reserved = reserved + operation.estimatedUnits
    state = 'recovered'
  elseif state == 'settled' then
    actual = tostring(operation.actualUnits)
  end
  table.insert(fields, 'operation:' .. operation.operationId)
  table.insert(fields, state .. '|' .. operation.revision .. '|' .. operation.estimatedUnits .. '|' .. actual)
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'consumed', snapshot.consumed, 'reserved', reserved,
  'ready', '1', 'retainUntil', ARGV[3])
for index = 1, #fields, 2 do redis.call('HSET', KEYS[1], fields[index], fields[index + 1]) end
-- Never expire an outstanding hold. Terminal markers and aggregates expire together.
if reserved == 0 then redis.call('EXPIREAT', KEYS[1], math.max(tonumber(ARGV[3]), now + 86400)) end
return 'ok'
`

/**
 * Lua Script: reserve.lua
 *
 * Atomically evaluates pre-flight quota admission and holds capacity reservations in Redis.
 * KEYS[1]: usage:{orgId}:{metric}:{billingPeriodId}.
 * ARGV: operation ID, limit (-1 means unlimited), estimated units.
 * Same-operation retries reuse the hold. Missing/unready state blocks admission.
 * Return array: [allowed (0|1), consumed, reserved], or an unavailable/mismatch/invalid status.
 * Outstanding holds expire only through durable settlement or cancellation.
 */
const RESERVE_LUA = `
if redis.call('HGET', KEYS[1], 'ready') ~= '1' then return {'unavailable'} end
local operationId = ARGV[1]
local limit = tonumber(ARGV[2])
local estimate = tonumber(ARGV[3])
local field = 'operation:' .. operationId
local stored = redis.call('HGET', KEYS[1], field)
local consumed = tonumber(redis.call('HGET', KEYS[1], 'consumed')) or 0
local reserved = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'reserved')) or 0)

if not limit or not estimate or estimate < 0 then return {'invalid', consumed, reserved} end
if stored then
  local state, _, storedEstimate = string.match(stored, '([^|]+)|([^|]+)|([^|]+)|([^|]+)')
  if state == 'reserved' and tonumber(storedEstimate) == estimate then return {1, consumed, reserved} end
  if state == 'recovered' and tonumber(storedEstimate) == estimate then
    if limit ~= -1 and consumed + reserved > limit then return {0, consumed, reserved} end
    redis.call('HSET', KEYS[1], field, 'reserved|0|' .. estimate .. '|-')
    redis.call('PERSIST', KEYS[1])
    return {1, consumed, reserved}
  end
  return {'mismatch', consumed, reserved}
end
if limit ~= -1 and (consumed + reserved + estimate) > limit then return {0, consumed, reserved} end

-- Durable operation state owns reservation lifetime; cache TTL must not release a live hold.
redis.call('PERSIST', KEYS[1])
redis.call('HINCRBY', KEYS[1], 'reserved', estimate)
redis.call('HSET', KEYS[1], field, 'reserved|0|' .. estimate .. '|-')
return {1, consumed, reserved + estimate}
`

/**
 * Lua Script: settle.lua
 *
 * Atomically settles or cancels an operation, releasing its hold exactly once.
 * KEYS[1]: usage:{orgId}:{metric}:{billingPeriodId}.
 * ARGV: operation ID, terminal revision, estimate, settled/cancelled, actual units.
 * Matching terminal markers make retries a no-op; conflicting replays return mismatch.
 * Return array: [ok, consumed], or unavailable/mismatch/invalid/inconsistent.
 * Totals and terminal markers expire together only after all holds are released.
 */
const SETTLE_LUA = `
if redis.call('HGET', KEYS[1], 'ready') ~= '1' then return {'unavailable'} end
local operationId = ARGV[1]
local revision = tonumber(ARGV[2])
local estimate = tonumber(ARGV[3])
local state = ARGV[4]
local actual = tonumber(ARGV[5])
local field = 'operation:' .. operationId
local stored = redis.call('HGET', KEYS[1], field)
local consumed = tonumber(redis.call('HGET', KEYS[1], 'consumed')) or 0

if state ~= 'settled' and state ~= 'cancelled' then return {'invalid'} end
if not revision or revision < 1 or not estimate or estimate < 0 then return {'invalid'} end
if state == 'settled' and (not actual or actual < 0) then return {'invalid'} end
local storedActual = '-'

if stored then
  local storedState, storedRevision, storedEstimate
  storedState, storedRevision, storedEstimate, storedActual = string.match(stored, '([^|]+)|([^|]+)|([^|]+)|([^|]+)')
  if storedState == state and tonumber(storedRevision) == revision and tonumber(storedEstimate) == estimate and
     ((state == 'cancelled' and storedActual == '-') or (state == 'settled' and tonumber(storedActual) == actual)) then
    return {'ok', consumed}
  end
  if (storedState ~= 'reserved' and storedState ~= 'recovered') or tonumber(storedEstimate) ~= estimate then return {'mismatch'} end
  if revision ~= 1 then return {'mismatch'} end
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved')) or 0
  if reserved < estimate then return {'inconsistent'} end
  redis.call('HSET', KEYS[1], 'reserved', reserved - estimate)
else
  if revision ~= 1 then return {'mismatch'} end
  if state == 'settled' then return {'inconsistent'} end
end

if state == 'settled' then
  consumed = redis.call('HINCRBY', KEYS[1], 'consumed', actual)
  storedActual = tostring(actual)
else
  storedActual = '-'
end
redis.call('HSET', KEYS[1], field, state .. '|' .. revision .. '|' .. estimate .. '|' .. storedActual)
if tonumber(redis.call('HGET', KEYS[1], 'reserved')) == 0 then
  local now = tonumber(redis.call('TIME')[1])
  local retainUntil = tonumber(redis.call('HGET', KEYS[1], 'retainUntil')) or now
  redis.call('EXPIREAT', KEYS[1], math.max(retainUntil, now + 86400))
end
return {'ok', consumed}
`

export function buildQuotaUsageKey(orgId: string, metric: string, billingPeriodId: string): string {
  return `usage:${orgId}:${metric}:${billingPeriodId}`
}

@Injectable()
export class RedisQuotaAdmissionClient implements QuotaAdmissionClient {
  constructor(@Inject(RedisClient) private readonly redis: QuotaAdmissionRedisClient) {
    this.defineCommands()
  }

  private defineCommands(): void {
    this.redis.defineCommand("beginQuotaRebuild", {numberOfKeys: 1, lua: BEGIN_REBUILD_LUA})
    this.redis.defineCommand("restoreQuotaCache", {numberOfKeys: 1, lua: RESTORE_CACHE_LUA})
    this.redis.defineCommand("reserveQuota", {
      numberOfKeys: 1,
      lua: RESERVE_LUA
    })
    this.redis.defineCommand("settleQuota", {
      numberOfKeys: 1,
      lua: SETTLE_LUA
    })
  }

  beginRebuild(key: string, owner: string): TE.TaskEither<QuotaAdmissionError, "ready" | "claimed" | "busy"> {
    return pipe(
      TE.tryCatch(
        () => this.redis.beginQuotaRebuild(key, owner),
        (error): QuotaAdmissionError => ({type: "admission_error", error})
      ),
      TE.chain(response =>
        response === "ready" || response === "claimed" || response === "busy"
          ? TE.right(response)
          : TE.left<QuotaAdmissionError>({type: "invalid_response", error: response})
      )
    )
  }

  restore(
    key: string,
    owner: string,
    snapshot: UsageCacheSnapshot,
    retainUntil: Date
  ): TE.TaskEither<QuotaAdmissionError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.restoreQuotaCache(key, owner, JSON.stringify(snapshot), Math.floor(retainUntil.getTime() / 1000)),
        (error): QuotaAdmissionError => ({type: "admission_error", error})
      ),
      TE.chain(response =>
        response === "ok" ? TE.right(undefined) : TE.left<QuotaAdmissionError>({type: "cache_unavailable"})
      )
    )
  }

  reserveOperation(
    key: string,
    operationId: string,
    limit: TierQuotaLimit,
    estimate: number
  ): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult> {
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.reserveQuota(key, operationId, limit === "UNLIMITED" ? UNLIMITED_QUOTA_SENTINEL : limit, estimate),
        (error): QuotaAdmissionError => ({type: "admission_error", error})
      ),
      TE.chainW((res): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult> => {
        if (Array.isArray(res) && res[0] === "unavailable")
          return TE.left<QuotaAdmissionError>({type: "cache_unavailable"})
        if (!Array.isArray(res) || res.length < 3)
          return TE.left<QuotaAdmissionError>({type: "invalid_response", error: res})
        if (res[0] === "mismatch") return TE.left<QuotaAdmissionError>({type: "operation_mismatch"})
        if (res[0] === "invalid") return TE.left<QuotaAdmissionError>({type: "invalid_response", error: res})
        if (Number(res[0]) === 0) return TE.left("quota_exceeded" as const)
        return TE.right({
          consumed: Number(res[1]),
          reserved: Number(res[2])
        })
      })
    )
  }

  applySettlement(
    key: string,
    operationId: string,
    revision: string,
    estimate: number,
    result: UsageSettlementResult
  ): TE.TaskEither<QuotaAdmissionError, number> {
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.settleQuota(
            key,
            operationId,
            revision,
            estimate,
            result.state,
            result.state === "settled" ? result.actualUnits : 0
          ),
        (error): QuotaAdmissionError => ({type: "admission_error", error})
      ),
      TE.chain(response => {
        if (Array.isArray(response) && response[0] === "unavailable")
          return TE.left<QuotaAdmissionError>({type: "cache_unavailable"})
        if (Array.isArray(response) && response[0] === "mismatch")
          return TE.left<QuotaAdmissionError>({type: "operation_mismatch"})
        if (!Array.isArray(response) || response.length < 2)
          return TE.left<QuotaAdmissionError>({type: "invalid_response", error: response})
        if (response[0] !== "ok") return TE.left<QuotaAdmissionError>({type: "invalid_response", error: response})
        return TE.right(Number(response[1]))
      })
    )
  }

  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: number; reserved: number}> {
    return pipe(
      TE.tryCatch(
        () => this.redis.hmget(key, "ready", "consumed", "reserved"),
        (error): QuotaAdmissionError => ({type: "admission_error", error})
      ),
      TE.chain(([ready, consumed, reserved]) =>
        ready === "1"
          ? TE.right({consumed: Number(consumed), reserved: Number(reserved)})
          : TE.left<QuotaAdmissionError>({type: "cache_unavailable"})
      )
    )
  }
}
