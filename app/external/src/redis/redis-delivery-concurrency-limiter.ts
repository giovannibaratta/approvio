import {Injectable} from "@nestjs/common"
import {DeliveryPermit, DeliveryPermitFactory, TenantContext} from "@domain"
import {DeliveryConcurrencyLimiter, WorkError} from "@services/durable-work/interfaces"
import {isUUIDv5, isUUIDv7} from "@utils"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {ConfigProvider} from "../config"
import {RedisClient} from "./redis-client"

/**
 * Shared delivery slots across worker replicas, scoped to one organization.
 * TaskService holds a permit around dispatch and checks it before external I/O;
 * the database attempt lease is checked separately. Redis failures deny admission.
 *
 * Each script runs atomically: acquire must check capacity and reserve together,
 * and release must check ownership and delete together. Separate client commands
 * would allow over-admission or let a stale execution remove its replacement.
 *
 * KEYS (passed explicitly by each method):
 * 1. expiry: sorted set of task IDs, scored by lease expiry in epoch milliseconds.
 * 2. holders: hash with <taskId>:owner and <taskId>:fencing fields, both strings.
 * 3. fencing: organization-wide generation counter, used only by ACQUIRE.
 * A Redis hash is a field/value map; a sorted set stores unique members with
 * numeric scores. Here, the members are task IDs and their scores are expiries.
 * redis.call(command, ...) executes a Redis command from Lua; command errors
 * abort the script. Lua arrays use indices starting at 1.
 *
 * owner is a fresh execution UUID, not a stable worker ID. Both owner and fencing
 * must match: Redis state loss can reset the counter, so generation alone is unsafe.
 * Redis TIME avoids disagreement between worker clocks. Leases have fixed expiry;
 * neither reacquiring nor validating renews them. Expiry recovers slots after a
 * crash, but cannot cancel external I/O already started by an expired holder.
 */

// ARGV: task ID, execution owner, organization capacity, lease duration in ms.
// Returns [owner, fencing, expiryMs] as strings, or capacity_exceeded, delivery_permit_held_by_another_owner,
// or delivery_permit_state_inconsistent (an expiry entry has incomplete holder data).
const ACQUIRE = `
-- TIME returns {Unix seconds, microseconds within that second}, both strings.
-- Convert seconds to ms and truncate the microsecond remainder to whole ms.
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

-- Expiry is a sorted-set score, not a Redis key TTL. Delete expired reservations
-- to release their slots and free capacity, including when a worker crashed
-- without releasing its permit. Remove both holder fields and sorted-set entries
-- before counting the remaining active reservations.
-- ZRANGEBYSCORE lists members with scores in the inclusive range [-infinity, now].
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)

for _, task in ipairs(expired) do
  -- HDEL removes both named fields for the expired task from the hash.
  redis.call('HDEL', KEYS[2], task .. ':owner', task .. ':fencing')
end

-- ZREMRANGEBYSCORE removes the expired members from the sorted set itself.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

-- An acquisition retry by the same execution returns its original permit,
-- even at capacity. A competing execution cannot take over a live task.
-- ZSCORE reads this task's score (expiry) as a string; absent members are false in Lua.
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])

-- These are fields within the holders hash, not additional Redis keys.
local ownerField = ARGV[1] .. ':owner'
local fencingField = ARGV[1] .. ':fencing'

if expiry then
  -- HMGET returns field values in the requested order; missing values are false.
  local holder = redis.call('HMGET', KEYS[2], ownerField, fencingField)
  local owner = holder[1]
  local fencing = holder[2]

  if not owner or not fencing then
    return 'delivery_permit_state_inconsistent'
  end

  if owner ~= ARGV[2] then
    return 'delivery_permit_held_by_another_owner'
  end

  return {owner, fencing, expiry}
end

-- Checking and reserving within this script prevents simultaneous workers
-- from each observing the same free slot.
-- ZCARD returns the number of sorted-set members: the active reservations.
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 'capacity_exceeded'
end

-- Ignore INCR's Lua numeric reply and GET the exact decimal string instead.
-- Converting the generation to a Lua number could lose integer precision.
-- INCR adds 1 to the integer stored at the counter key, starting from 0 if absent.
redis.call('INCR', KEYS[3])
-- GET returns the counter's stored string value without Lua numeric conversion.
local fencing = redis.call('GET', KEYS[3])
local expiresAt = now + tonumber(ARGV[4])

-- HSET writes both named fields directly, without JSON encoding.
redis.call('HSET', KEYS[2], ownerField, ARGV[2], fencingField, fencing)

-- ZADD adds/updates the task member with expiresAt as its numeric score.
redis.call('ZADD', KEYS[1], expiresAt, ARGV[1])
return {ARGV[2], fencing, tostring(expiresAt)}
`

// KEYS: expiry, holders. ARGV: task ID, execution owner, fencing string.
// Returns ok for the current, unexpired permit, lease_lost for absent/expired/mismatched
// ownership, or delivery_permit_state_inconsistent for a partial reservation.
const ASSERT_LEASE = `
-- TIME returns {Unix seconds, microseconds within that second}; convert to ms.
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
-- HMGET reads owner and fencing as strings in that order; absent fields are false.
local holder = redis.call('HMGET', KEYS[2], ARGV[1] .. ':owner', ARGV[1] .. ':fencing')
local owner = holder[1]
local fencing = holder[2]

-- ZSCORE reads the expiry score as a string, or false when the task is absent.
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])

-- A partial reservation is corrupt; a completely absent reservation is a lost lease.
if (owner or fencing or expiry) and (not owner or not fencing or not expiry) then
  return 'delivery_permit_state_inconsistent'
end

-- Read-only check: absent or expired state denies permission without renewal.
if not expiry or tonumber(expiry) <= now then
  return 'lease_lost'
end

if owner ~= ARGV[2] or fencing ~= ARGV[3] then
  return 'lease_lost'
end

return 'ok'
`

// KEYS: expiry, holders. ARGV: task ID, execution owner, fencing string.
// Returns ok if absent or removed, lease_lost for mismatched ownership,
// or delivery_permit_state_inconsistent for incomplete holder data.
const RELEASE = `

-- Build the owner and fencing field names. Note: Lua string concatenation uses '..'
local ownerField = ARGV[1] .. ':owner'
local fencingField = ARGV[1] .. ':fencing'
-- HMGET reads both named fields; each missing field is returned as false.
local holder = redis.call('HMGET', KEYS[2], ownerField, fencingField)
-- Extract the fields from the Redis response
local owner = holder[1]
local fencing = holder[2]

-- Repeated cleanup is harmless. Expiry need not be checked: an expired holder
-- may clean up its own entry, but must never remove a replacement's entry.
if not owner and not fencing then
  return 'ok'
end

-- One missing field indicates corrupt ownership rather than a competing execution.
if not owner or not fencing then
  return 'delivery_permit_state_inconsistent'
end

-- If there is a mismatch with the current stored values, it's a lease loss
if owner ~= ARGV[2] or fencing ~= ARGV[3] then
  return 'lease_lost'
end

-- If they match, the lease is still held by the same execution, remove it

-- ZREM removes the task member and its expiry score from the sorted set.
redis.call('ZREM', KEYS[1], ARGV[1])
-- HDEL removes both owner and fencing fields from the hash.
redis.call('HDEL', KEYS[2], ownerField, fencingField)

return 'ok'
`

@Injectable()
export class RedisDeliveryConcurrencyLimiter implements DeliveryConcurrencyLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly config: ConfigProvider
  ) {}

  /**
   * Reserves a fixed-duration slot, or returns the same execution's live permit.
   * A full organization returns capacity_exceeded; another owner returns delivery_permit_held_by_another_owner.
   */
  acquirePermit(
    context: TenantContext,
    taskId: string,
    owner: string
  ): TE.TaskEither<WorkError | "capacity_exceeded", DeliveryPermit> {
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("dispatch_work_invalid_id")
    if (!owner.trim()) return TE.left("lease_invalid_owner")

    const keys = this.getRedisKeys(context)
    // EVAL consumes this many key names into Lua KEYS; following arguments become ARGV.
    const scriptKeys = [keys.expiry, keys.holders, keys.fencing]

    return pipe(
      TE.tryCatch(
        () =>
          this.redis.eval(
            ACQUIRE,
            scriptKeys.length,
            ...scriptKeys,
            taskId,
            owner,
            this.config.dispatchConfig.concurrencyPerOrganization,
            this.config.dispatchConfig.leaseDurationMs
          ),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(readPermit)
    )
  }

  /** Checks Redis ownership and expiry without renewing the permit or checking the DB lease. */
  validatePermit(context: TenantContext, taskId: string, permit: DeliveryPermit): TE.TaskEither<WorkError, void> {
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("dispatch_work_invalid_id")
    const keys = this.getRedisKeys(context)
    const scriptKeys = [keys.expiry, keys.holders]

    return pipe(
      TE.tryCatch(
        () =>
          this.redis.eval(
            ASSERT_LEASE,
            scriptKeys.length,
            ...scriptKeys,
            taskId,
            permit.owner,
            permit.fencing.toString()
          ),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(readLeaseResult)
    )
  }

  /** Releases only the matching execution; an already absent permit is a successful no-op. */
  releasePermit(context: TenantContext, taskId: string, permit: DeliveryPermit): TE.TaskEither<WorkError, void> {
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("dispatch_work_invalid_id")
    const keys = this.getRedisKeys(context)
    const scriptKeys = [keys.expiry, keys.holders]

    return pipe(
      TE.tryCatch(
        () =>
          this.redis.eval(RELEASE, scriptKeys.length, ...scriptKeys, taskId, permit.owner, permit.fencing.toString()),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(readLeaseResult)
    )
  }

  /** Names the organization's lease storage; callers select keys in their script's required order. */
  private getRedisKeys(context: TenantContext): DeliveryConcurrencyRedisKeys {
    // The shared {organizationId} hash tag keeps all script keys in one Redis Cluster slot.
    const prefix = `${this.config.redisConfig.prefix ?? ""}dispatch:{${context.organizationId}}`
    return {expiry: `${prefix}:expiry`, holders: `${prefix}:holders`, fencing: `${prefix}:fencing`}
  }
}

interface DeliveryConcurrencyRedisKeys {
  readonly expiry: string
  readonly holders: string
  readonly fencing: string
}

/** Decodes acquisition outcomes and validates the string tuple returned by Lua. */
function readPermit(response: unknown): E.Either<WorkError, DeliveryPermit> {
  if (response === "capacity_exceeded") return E.left("capacity_exceeded")
  if (response === "delivery_permit_held_by_another_owner") return E.left("delivery_permit_held_by_another_owner")
  if (response === "delivery_permit_state_inconsistent") return E.left("delivery_permit_state_inconsistent")

  if (
    !Array.isArray(response) ||
    response.length !== 3 ||
    typeof response[0] !== "string" ||
    typeof response[1] !== "string" ||
    !/^[1-9]\d*$/.test(response[1]) ||
    typeof response[2] !== "string" ||
    !/^\d+$/.test(response[2])
  )
    return E.left("delivery_permit_invalid_response")

  // Keep conversion failures inside Either: chainEitherKW does not catch thrown
  // exceptions. The factory separately checks owner and timestamp validity.
  const owner = response[0]
  const fencing = response[1]
  const expiresAt = response[2]
  return pipe(
    E.tryCatch(
      () => ({owner, fencing: BigInt(fencing), expiresAt: new Date(Number(expiresAt))}),
      () => "delivery_permit_invalid_response" as const
    ),
    E.chainW(data => DeliveryPermitFactory.validate(data))
  )
}

/** Both ownership checks and releases use the same Redis status protocol. */
function readLeaseResult(response: unknown): E.Either<WorkError, void> {
  if (response === "ok") return E.right(undefined)
  if (response === "lease_lost") return E.left("lease_lost")
  if (response === "delivery_permit_state_inconsistent") return E.left("delivery_permit_state_inconsistent")
  return E.left("delivery_permit_invalid_response")
}
