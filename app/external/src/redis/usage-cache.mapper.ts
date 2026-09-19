import {UsageCacheOperation} from "@services/usage-metering"
import {parse as parseUuid} from "uuid"

const SETTLED_VALUE = "S"
const CANCELLED_VALUE = "C"

interface RedisUsageCacheEntry {
  readonly field: Buffer
  readonly value: string
  readonly expiresAt?: Date
}

/** Encode semantic operation state into the Redis hash format used by the Lua scripts. */
export function encodeUsageCacheOperation(operation: UsageCacheOperation): RedisUsageCacheEntry {
  // Keep every UUID bit; binary encoding uses 16 bytes without introducing collisions.
  const field = Buffer.from(parseUuid(operation.operationId))
  if (operation.state === "reserved" || operation.state === "pending_admission")
    return {field, value: `${operation.state}|${operation.estimatedUnits}`}
  const value = operation.state === "settled" ? SETTLED_VALUE : CANCELLED_VALUE
  return {field, value, expiresAt: operation.expiresAt}
}
