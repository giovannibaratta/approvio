import {isUsageQuantity, parseUsageQuantity} from "@domain"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {
  QuotaAdmissionClient,
  QuotaAdmissionError,
  ReservationResult,
  UsageCacheSnapshot,
  UsageCacheReservation,
  UsageCacheSettlement
} from "@services/usage-metering"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {RedisClient} from "./redis-client"
import {USAGE_QUANTITY_LUA} from "./usage-quantity.lua"
import {encodeUsageCacheOperation} from "./usage-cache.mapper"

interface QuotaAdmissionCommands {
  beginQuotaRebuild(key: string, owner: string): Promise<unknown>
  restoreQuotaCache(args: Array<string | Buffer | number>): Promise<unknown>
  reserveQuota(
    key: string,
    field: Buffer,
    limit: string,
    estimate: string,
    expiresAt: number,
    value: string
  ): Promise<unknown>
  settleQuota(
    key: string,
    field: Buffer,
    estimate: string,
    state: string,
    actual: string,
    value: string,
    replayWindowEndsAt: number,
    expiresAt: number,
    minimumCacheExpiresAt: number
  ): Promise<unknown>
}

export type QuotaAdmissionRedisClient = RedisClient & QuotaAdmissionCommands

/**
 * These scripts use one Redis key per organization, metric, and billing period:
 * KEYS[1] = usage:{orgId}:{metric}:{billingPeriodId}. Its value is a Redis hash
 * mapping the following field names to strings:
 * - ready: "1" when the usage cache is initialized for admission and settlement.
 * - consumed: total settled usage, stored as a decimal string.
 * - reserved: total estimates held by reserved and pending_admission operations, stored as a
 *   decimal string. Never convert usage quantities to Lua numbers.
 * - rebuildOwner: token identifying the worker allowed to publish a rebuilt cache
 *   when usage is missing or unready.
 * - rebuildLeaseExpiresAt: Unix-second deadline for that worker's lease. After
 *   expiry another worker can claim recovery. Publishing removes both lease fields.
 * - retainUntil: earliest whole-key expiry time once all holds are released, in
 *   seconds since January 1, 1970 UTC. The key expires at this time or 24 hours
 *   after the write, whichever is later. This retains aggregates independently
 *   of the shorter lifetime of individual completed-operation markers.
 * - binary UUID field (16 bytes): an active hold uses "state|estimate";
 *   a completed operation uses "S" (settled) or "C" (cancelled). Completed fields
 *   expire 48 hours after the later of the start deadline and completion/application.
 *
 * Operation records identify an existing hold or completed outcome so retries cannot
 * reserve or charge twice. Recovery restores holds as pending_admission until a
 * retry rechecks the limit. A successful check changes the state to reserved.
 *
 * Lua keeps each read/check/write sequence atomic relative to other Redis commands.
 * Validate before mutating: a script error does not roll back earlier Redis writes.
 * Positive holds prevent whole-key expiry. Active fields have no individual expiry.
 * Expired admission cannot recreate a hold after its completed marker disappears.
 * Settlement receives the immutable outcome read from PostgreSQL; it does not accept
 * an arbitrary caller's changed outcome based only on a compact marker.
 */

/**
 * Acquires a lease before a worker loads durable usage to rebuild this cache.
 * ARGV[1] is the worker's owner token, which must also be supplied when publishing.
 * Returns "ready" if no rebuild is needed, "busy" if an unexpired lease exists,
 * or "claimed" after recording the token and a 60-second lease using Redis time.
 */
const BEGIN_REBUILD_LUA = `
-- A usable cache needs no rebuild. Otherwise only an expired/missing lease can be claimed.
local ready = redis.call('HGET', KEYS[1], 'ready')
if ready == '1' then return 'ready' end
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1])
local storedLeaseExpiresAt = redis.call('HGET', KEYS[1], 'rebuildLeaseExpiresAt')
local leaseExpiresAt = tonumber(storedLeaseExpiresAt) or 0
if leaseExpiresAt > now then return 'busy' end
redis.call('HSET', KEYS[1], 'rebuildOwner', ARGV[1], 'rebuildLeaseExpiresAt', now + 60)
return 'claimed'
`

/**
 * Publishes the service's prepared replacement only while the rebuild lease is valid.
 * ARGV[1]: owner; ARGV[2..3]: consumed and reserved decimal-string totals;
 * ARGV[4]: whole-key retention deadline in seconds; ARGV[5]: key expiry in
 * milliseconds (0 means no expiry). Remaining arguments are field/value/expiry
 * triples, with absolute millisecond expiries (0 keeps the field indefinitely).
 * The service computes totals, stored values, and expiry dates before calling.
 * Redis time is used only to reject a worker whose rebuild lease has expired.
 */
const RESTORE_CACHE_LUA = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1])
local rebuildOwner = redis.call('HGET', KEYS[1], 'rebuildOwner')
if rebuildOwner ~= ARGV[1] then return 'rebuild_lease_lost' end
local storedLeaseExpiresAt = redis.call('HGET', KEYS[1], 'rebuildLeaseExpiresAt') or '0'
local leaseExpiresAt = tonumber(storedLeaseExpiresAt)
if leaseExpiresAt <= now then return 'rebuild_lease_lost' end

-- DEL removes the old fields and rebuild lease. No other command can observe a partial replacement.
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'consumed', ARGV[2], 'reserved', ARGV[3], 'ready', '1', 'retainUntil', ARGV[4])
for index = 6, #ARGV, 3 do
  local field = ARGV[index]
  local value = ARGV[index + 1]
  local expiresAt = tonumber(ARGV[index + 2])
  redis.call('HSET', KEYS[1], field, value)
  -- A date that elapsed after preparation immediately removes the completed field.
  if expiresAt > 0 then redis.call('HPEXPIREAT', KEYS[1], expiresAt, 'FIELDS', 1, field) end
end
local keyExpiresAt = tonumber(ARGV[5])
if keyExpiresAt > 0 then redis.call('PEXPIREAT', KEYS[1], keyExpiresAt) end
return 'ok'
`

/**
 * Checks the quota before admitting an operation and records its estimated usage.
 * ARGV[1]: prepared operation field; ARGV[2]: decimal-string limit ("-1" means unlimited);
 * ARGV[3]: decimal-string estimate.
 * ARGV[4]: last allowed start time in milliseconds.
 * ARGV[5]: the service's encoded reservation value.
 * A matching reserved operation succeeds without another limit check or total update.
 * An operation pending admission rechecks the limit against totals that already include its hold.
 * A new operation checks consumed + reserved + estimate before adding its hold.
 * Returns [1, consumed, reserved] on admission or [0, consumed, reserved] on quota
 * excess. Returns ["unavailable"] for an unready cache, ["invalid"] for invalid
 * quantities, or ["mismatch", consumed, reserved] for an incompatible existing marker.
 * Admission removes the key's expiry. Settlement or cancellation releases holds.
 */
const RESERVE_LUA = `${USAGE_QUANTITY_LUA}
-- Check the trusted deadline even for a retry whose completed marker has already expired.
local field, limit, estimate = ARGV[1], ARGV[2], ARGV[3]
local reservationValue = ARGV[5]
local startDeadline = tonumber(ARGV[4])
if not startDeadline then return {'invalid'} end
local redisTime = redis.call('TIME')
local seconds = tonumber(redisTime[1])
local microseconds = tonumber(redisTime[2])
local elapsedMilliseconds = math.floor(microseconds / 1000)
local nowMs = seconds * 1000 + elapsedMilliseconds
if startDeadline <= nowMs then return {'expired'} end
local ready = redis.call('HGET', KEYS[1], 'ready')
if ready ~= '1' then return {'unavailable'} end
local stored = redis.call('HGET', KEYS[1], field)
local consumed = redis.call('HGET', KEYS[1], 'consumed')
local reserved = redis.call('HGET', KEYS[1], 'reserved')
if not is_quantity(consumed) or not is_quantity(reserved) or not is_quantity(estimate) or
   (limit ~= '-1' and not is_quantity(limit)) then return {'invalid'} end
local currentUsage = add(consumed, reserved)
if not is_quantity(currentUsage) then return {'invalid'} end
if stored then
  local state, storedEstimate = string.match(stored, '^([^|]+)|([^|]+)$')
  -- An admitted retry already owns capacity; do not reserve or charge it again.
  if state == 'reserved' and storedEstimate == estimate then return {1, consumed, reserved} end
  if state == 'pending_admission' and storedEstimate == estimate then
    -- Recovery already included this estimate in reserved. Recheck the limit without adding it.
    local quotaExceeded = limit ~= '-1' and compare(currentUsage, limit) > 0
    if quotaExceeded then return {0, consumed, reserved} end
    redis.call('HSET', KEYS[1], field, reservationValue)
    redis.call('PERSIST', KEYS[1])
    return {1, consumed, reserved}
  end
  -- A different estimate or terminal marker cannot be reused as a new reservation.
  return {'mismatch', consumed, reserved}
end

-- First admission: include the new hold and reject excess before checking bigint overflow.
-- This preserves quota_exceeded when the finite limit is exceeded by an oversized total.
local nextReserved = add(reserved, estimate)
local total = add(consumed, nextReserved)
local quotaExceeded = limit ~= '-1' and compare(total, limit) > 0
if quotaExceeded then return {0, consumed, reserved} end
if not is_quantity(total) then return {'invalid'} end

-- Validate the complete transition before writing: Redis scripts do not roll back prior writes on errors.
redis.call('PERSIST', KEYS[1])
redis.call('HSET', KEYS[1], 'reserved', nextReserved, field, reservationValue)
return {1, consumed, nextReserved}
`

/**
 * Applies an operation's durable settlement or cancellation to cached usage.
 * Settlement releases the estimate from reserved and adds actual usage to consumed;
 * cancellation releases only the estimate. Cancellation without a hold records a
 * terminal marker without changing totals, since it can precede Redis admission.
 * ARGV[1]: prepared operation field; ARGV[2]: decimal-string estimate;
 * ARGV[3]: "settled" or "cancelled"; ARGV[4]: actual usage ("0" for cancellation);
 * ARGV[5]: the service's encoded completed value; ARGV[6]: replay-window deadline;
 * ARGV[7]: completed-field expiry; ARGV[8]: minimum whole-key expiry.
 * All dates are required absolute millisecond timestamps.
 * Quantities are decimal strings. A matching completed marker leaves totals unchanged.
 * Deadline-bound outcomes are validated in PostgreSQL before this script is called.
 * Returns ["ok", consumed], ["unavailable"] for an unready cache, ["mismatch"] for
 * a conflicting record, or ["invalid"] for invalid quantities, dates, or state.
 * Returns ["inconsistent"] for a missing hold within the retry window or a reserved
 * total below its estimate. After that window, a missing hold is already reflected
 * in the aggregates; expired admission cannot recreate it.
 * When reserved reaches zero, compares the shared key retention date with the
 * service's prepared minimum expiry before scheduling whole-key expiry.
 */
const SETTLE_LUA = `${USAGE_QUANTITY_LUA}
-- Settlements require a complete cache; recovery reconstructs missing durable state first.
local ready = redis.call('HGET', KEYS[1], 'ready')
if ready ~= '1' then return {'unavailable'} end
local field, estimate, state, actual = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local completedValue = ARGV[5]
local replayWindowEndsAt = tonumber(ARGV[6])
local markerExpiresAt = tonumber(ARGV[7])
local minimumCacheExpiresAt = tonumber(ARGV[8])
if not replayWindowEndsAt or not markerExpiresAt or not minimumCacheExpiresAt then return {'invalid'} end
local redisTime = redis.call('TIME')
local seconds = tonumber(redisTime[1])
local microseconds = tonumber(redisTime[2])
local elapsedMilliseconds = math.floor(microseconds / 1000)
local nowMs = seconds * 1000 + elapsedMilliseconds
local stored = redis.call('HGET', KEYS[1], field)
local consumed = redis.call('HGET', KEYS[1], 'consumed')
local reserved = redis.call('HGET', KEYS[1], 'reserved')

if not is_quantity(consumed) or not is_quantity(reserved) then return {'invalid'} end

local currentUsage = add(consumed, reserved)
if not is_quantity(currentUsage) or not is_quantity(estimate) or not is_quantity(actual) or
   (state ~= 'settled' and state ~= 'cancelled') then return {'invalid'} end

-- The service prepares the expected final record from PostgreSQL's immutable outcome.
if stored == completedValue then return {'ok', consumed} end

-- With no hold and an elapsed replay window, a legitimate result was already applied or
-- included by recovery. Expired admission cannot create another hold for this operation.

if not stored and nowMs >= replayWindowEndsAt then
  return {'ok', consumed}
end

local nextReserved = reserved

if stored then
  local storedState, storedEstimate = string.match(stored, '^([^|]+)|([^|]+)$')
  -- Only a matching live hold can be released; conflicting terminal replays are rejected.
  if (storedState ~= 'reserved' and storedState ~= 'pending_admission') or storedEstimate ~= estimate then return {'mismatch'} end
  local insufficientReservedUsage = compare(reserved, estimate) < 0
  if insufficientReservedUsage then return {'inconsistent'} end
  nextReserved = subtract(reserved, estimate)
-- Cancellation may arrive before Redis admission. Record it without releasing a missing hold.
-- Settlement requires an existing hold, otherwise consumed usage cannot be reconciled safely.
elseif state == 'settled' then return {'inconsistent'} end

-- Settlement replaces the estimate with actual usage; cancellation only releases the hold.
local nextConsumed = consumed
if state == 'settled' then
  nextConsumed = add(consumed, actual)
end
local nextUsage = add(nextConsumed, nextReserved)
if not is_quantity(nextUsage) then return {'invalid'} end

-- Persist totals and the terminal replay marker in the same atomic script execution.
redis.call('HSET', KEYS[1], 'consumed', nextConsumed, 'reserved', nextReserved, field, completedValue)
redis.call('HPEXPIREAT', KEYS[1], markerExpiresAt, 'FIELDS', 1, field)
if nextReserved == '0' then
  -- The key's retention deadline is shared state, so compare it with the service's
  -- prepared minimum only after this script has atomically released the final hold.
  local storedRetainUntil = redis.call('HGET', KEYS[1], 'retainUntil')
  local retainUntilSeconds = tonumber(storedRetainUntil) or 0
  local retainUntilMs = retainUntilSeconds * 1000
  local expiresAt = math.max(retainUntilMs, minimumCacheExpiresAt)
  redis.call('PEXPIREAT', KEYS[1], expiresAt)
end
return {'ok', nextConsumed}
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
      TE.tryCatch(() => this.redis.beginQuotaRebuild(key, owner), mapAdmissionError),
      TE.chain(response =>
        response === "ready" || response === "claimed" || response === "busy"
          ? TE.right(response)
          : TE.left<QuotaAdmissionError>(mapInvalidResponse(response))
      )
    )
  }

  restore(key: string, owner: string, snapshot: UsageCacheSnapshot): TE.TaskEither<QuotaAdmissionError, void> {
    const entries = snapshot.operations.flatMap(operation => {
      const encoded = encodeUsageCacheOperation(operation)
      return [encoded.field, encoded.value, encoded.expiresAt?.getTime() ?? 0]
    })
    return pipe(
      TE.tryCatch(
        () =>
          // ioredis flattens an array argument; avoid JavaScript's function-argument limit on large snapshots.
          this.redis.restoreQuotaCache([
            key,
            owner,
            snapshot.consumed.toString(),
            snapshot.reserved.toString(),
            Math.floor(snapshot.retainUntil.getTime() / 1000),
            snapshot.expiresAt?.getTime() ?? 0,
            ...entries
          ]),
        mapAdmissionError
      ),
      TE.chain(response => {
        if (response === "ok") return TE.right(undefined)
        if (response === "rebuild_lease_lost") return TE.left<QuotaAdmissionError>("rebuild_lease_lost")
        return TE.left<QuotaAdmissionError>(mapInvalidResponse(response))
      })
    )
  }

  reserveOperation(
    key: string,
    reservation: UsageCacheReservation
  ): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult> {
    const encoded = encodeUsageCacheOperation(reservation)
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.reserveQuota(
            key,
            encoded.field,
            reservation.limit === "UNLIMITED" ? "-1" : reservation.limit.toString(),
            reservation.estimatedUnits.toString(),
            reservation.admissionExpiresAt.getTime(),
            encoded.value
          ),
        mapAdmissionError
      ),
      TE.chainW((res): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult> => {
        if (Array.isArray(res) && res[0] === "expired") return TE.left<QuotaAdmissionError>("operation_expired")
        if (Array.isArray(res) && res[0] === "unavailable") return TE.left<QuotaAdmissionError>("cache_unavailable")
        if (Array.isArray(res) && res[0] === "invalid") return TE.left<QuotaAdmissionError>("invalid_usage_data")
        if (!Array.isArray(res) || res.length < 3) return TE.left<QuotaAdmissionError>(mapInvalidResponse(res))
        if (res[0] === "mismatch") return TE.left<QuotaAdmissionError>("operation_mismatch")
        if (res[0] === 0) return TE.left("quota_exceeded" as const)
        if (res[0] !== 1) return TE.left<QuotaAdmissionError>(mapInvalidResponse(res))
        return TE.fromEither(parseCounters(res[1], res[2]))
      })
    )
  }

  applySettlement(key: string, settlement: UsageCacheSettlement): TE.TaskEither<QuotaAdmissionError, bigint> {
    const operation = settlement.operation
    const encoded = encodeUsageCacheOperation(operation)
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.settleQuota(
            key,
            encoded.field,
            operation.estimatedUnits.toString(),
            operation.state,
            operation.state === "settled" ? operation.actualUnits.toString() : "0",
            encoded.value,
            settlement.replayWindowEndsAt.getTime(),
            operation.expiresAt.getTime(),
            settlement.minimumCacheExpiresAt.getTime()
          ),
        mapAdmissionError
      ),
      TE.chain(response => {
        if (Array.isArray(response) && response[0] === "unavailable")
          return TE.left<QuotaAdmissionError>("cache_unavailable")
        if (Array.isArray(response) && response[0] === "mismatch")
          return TE.left<QuotaAdmissionError>("operation_mismatch")
        if (Array.isArray(response) && response[0] === "invalid")
          return TE.left<QuotaAdmissionError>("invalid_usage_data")
        if (Array.isArray(response) && response[0] === "inconsistent")
          return TE.left<QuotaAdmissionError>("usage_cache_inconsistent")
        if (!Array.isArray(response) || response.length < 2)
          return TE.left<QuotaAdmissionError>(mapInvalidResponse(response))
        if (response[0] !== "ok") return TE.left<QuotaAdmissionError>(mapInvalidResponse(response))
        return TE.fromEither(parseCounter(response[1]))
      })
    )
  }

  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: bigint; reserved: bigint}> {
    return pipe(
      TE.tryCatch(() => this.redis.hmget(key, "ready", "consumed", "reserved"), mapAdmissionError),
      TE.chain(([ready, consumed, reserved]) =>
        ready === "1"
          ? TE.fromEither(parseCounters(consumed, reserved))
          : TE.left<QuotaAdmissionError>("cache_unavailable")
      )
    )
  }
}

function mapAdmissionError(error: unknown): QuotaAdmissionError {
  Logger.error("Quota admission Redis operation failed", error, "RedisQuotaAdmissionClient")
  return "admission_error"
}

function mapInvalidResponse(response: unknown): QuotaAdmissionError {
  Logger.error("Invalid quota admission Redis response", response, "RedisQuotaAdmissionClient")
  return "invalid_response"
}

function parseCounter(value: unknown): E.Either<QuotaAdmissionError, bigint> {
  return pipe(
    parseUsageQuantity(value),
    E.mapLeft(() => mapInvalidResponse(value))
  )
}

function parseCounters(consumed: unknown, reserved: unknown): E.Either<QuotaAdmissionError, ReservationResult> {
  return pipe(
    E.Do,
    E.bind("consumed", () => parseCounter(consumed)),
    E.bind("reserved", () => parseCounter(reserved)),
    E.chain(counters =>
      isUsageQuantity(counters.consumed + counters.reserved)
        ? E.right(counters)
        : E.left(mapInvalidResponse({consumed, reserved}))
    )
  )
}
