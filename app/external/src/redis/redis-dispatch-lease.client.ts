import {Injectable} from "@nestjs/common"
import {isOrganizationId, Lease, LeaseFactory, TenantContext} from "@domain"
import {DispatchLeaseClient, WorkError} from "@services/durable-work/interfaces"
import {isUUIDv5, isUUIDv7} from "@utils"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {ConfigProvider} from "../config"
import {RedisClient} from "./redis-client"

// Redis owns the clock. Each organization has one expiry set, holder map, and lease-generation counter.
// Counter values are strings so Lua number precision cannot truncate the fencing token.
const ACQUIRE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, task in ipairs(expired) do redis.call('HDEL', KEYS[2], task) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
if expiry then
  local holder = redis.call('HGET', KEYS[2], ARGV[1])
  if not holder then return 'invalid_response' end
  local lease = cjson.decode(holder)
  if lease.owner ~= ARGV[2] then return 'lease_lost' end
  return {lease.owner, lease.fencing, expiry}
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 'capacity_exceeded' end
redis.call('INCR', KEYS[3])
local fencing = redis.call('GET', KEYS[3])
local expiresAt = now + tonumber(ARGV[4])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode({owner=ARGV[2], fencing=fencing}))
redis.call('ZADD', KEYS[1], expiresAt, ARGV[1])
return {ARGV[2], fencing, tostring(expiresAt)}
`
const ASSERT_LEASE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local holder = redis.call('HGET', KEYS[2], ARGV[1])
local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not holder or not expiry or tonumber(expiry) <= now then return 'lease_lost' end
local lease = cjson.decode(holder)
if lease.owner ~= ARGV[2] or lease.fencing ~= ARGV[3] then return 'lease_lost' end
return 'ok'
`
const RELEASE = `
local holder = redis.call('HGET', KEYS[2], ARGV[1])
if not holder then return 'ok' end
local lease = cjson.decode(holder)
if lease.owner ~= ARGV[2] or lease.fencing ~= ARGV[3] then return 'lease_lost' end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 'ok'
`

@Injectable()
export class RedisDispatchLeaseClient implements DispatchLeaseClient {
  constructor(
    private readonly redis: RedisClient,
    private readonly config: ConfigProvider
  ) {}

  acquire(
    context: TenantContext,
    taskId: string,
    owner: string
  ): TE.TaskEither<WorkError | "capacity_exceeded", Lease> {
    if (!isOrganizationId(context.organizationId)) return TE.left("invalid_organization_id")
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("task_not_found")
    if (!owner.trim()) return TE.left("lease_invalid_owner")
    const keys = this.keys(context)
    return pipe(
      TE.tryCatch(
        () =>
          this.redis.eval(
            ACQUIRE,
            3,
            ...keys,
            taskId,
            owner,
            this.config.dispatchConfig.concurrencyPerOrganization,
            this.config.dispatchConfig.leaseDurationMs
          ),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(response =>
        response === "capacity_exceeded" ? E.left("capacity_exceeded" as const) : readLease(response)
      )
    )
  }

  assertLease(context: TenantContext, taskId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    if (!isOrganizationId(context.organizationId)) return TE.left("invalid_organization_id")
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("task_not_found")
    const [expiryKey, holderKey] = this.keys(context)
    return pipe(
      TE.tryCatch(
        () => this.redis.eval(ASSERT_LEASE, 2, expiryKey, holderKey, taskId, lease.owner, lease.fencing.toString()),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(response => {
        if (response === "ok") return E.right(undefined)
        if (response === "lease_lost") return E.left("lease_lost" as const)
        return E.left("dispatch_lease_invalid_response" as const)
      })
    )
  }

  release(context: TenantContext, taskId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    if (!isOrganizationId(context.organizationId)) return TE.left("invalid_organization_id")
    if (!isUUIDv7(taskId) && !isUUIDv5(taskId)) return TE.left("task_not_found")
    const [expiryKey, holderKey] = this.keys(context)
    return pipe(
      TE.tryCatch(
        () => this.redis.eval(RELEASE, 2, expiryKey, holderKey, taskId, lease.owner, lease.fencing.toString()),
        () => "repository_dependency_error" as const
      ),
      TE.chainEitherKW(response => {
        if (response === "ok") return E.right(undefined)
        if (response === "lease_lost") return E.left("lease_lost" as const)
        return E.left("dispatch_lease_invalid_response" as const)
      })
    )
  }

  private keys(context: TenantContext): readonly [string, string, string] {
    const prefix = `${this.config.redisConfig.prefix ?? ""}dispatch:{${context.organizationId}}`
    return [`${prefix}:expiry`, `${prefix}:holders`, `${prefix}:fencing`]
  }
}

function readLease(response: unknown): E.Either<WorkError, Lease> {
  if (response === "lease_lost") return E.left("lease_lost")
  if (
    !Array.isArray(response) ||
    response.length !== 3 ||
    typeof response[0] !== "string" ||
    typeof response[1] !== "string" ||
    !/^[1-9]\d*$/.test(response[1]) ||
    typeof response[2] !== "string" ||
    !/^\d+$/.test(response[2])
  )
    return E.left("dispatch_lease_invalid_response")
  return LeaseFactory.validate({
    owner: response[0],
    fencing: BigInt(response[1]),
    expiresAt: new Date(Number(response[2]))
  })
}
