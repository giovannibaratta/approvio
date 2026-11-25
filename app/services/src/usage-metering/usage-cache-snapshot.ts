import {UsageOperationStateSnapshot, UsageSnapshot} from "../durable-work/models"
import {UsageCacheOperation, USAGE_REPLAY_RETENTION_MS, MINIMUM_USAGE_CACHE_RETENTION_MS} from "./usage-cache-operation"

/**
 * Replacement usage state for one organization, usage metric, and billing period.
 * The scope is identified by the cache key supplied separately to the admission client.
 * Contains aggregate totals, operation facts, and retention deadlines.
 */
export interface UsageCacheSnapshot {
  readonly consumed: bigint
  readonly reserved: bigint
  readonly retainUntil: Date
  readonly expiresAt?: Date
  readonly operations: ReadonlyArray<UsageCacheOperation>
}

export class UsageCacheSnapshotFactory {
  static create(snapshot: UsageSnapshot, retainUntil: Date): UsageCacheSnapshot {
    const now = Date.now()
    const reserved = snapshot.operations.reduce(
      (total, operation) => total + (operation.state === "reserved" ? operation.estimatedUnits : 0n),
      0n
    )
    return {
      consumed: snapshot.consumed,
      reserved,
      retainUntil,
      ...(reserved === 0n
        ? {expiresAt: new Date(Math.max(retainUntil.getTime(), now + MINIMUM_USAGE_CACHE_RETENTION_MS))}
        : {}),
      operations: snapshot.operations.flatMap(operation => prepareOperation(operation, now))
    }
  }
}

function prepareOperation(operation: UsageOperationStateSnapshot, now: number): ReadonlyArray<UsageCacheOperation> {
  const identity = {
    operationId: operation.operationId,
    estimatedUnits: operation.estimatedUnits,
    admissionExpiresAt: operation.expiresAt
  }
  // Durable reservation can precede admission. Count the hold, but require a limit recheck.
  if (operation.state === "reserved") return [{...identity, state: "pending_admission"}]

  const expiresAt = new Date(
    Math.max(operation.expiresAt.getTime(), operation.completedAt.getTime()) + USAGE_REPLAY_RETENTION_MS
  )
  // Expired records are omitted, but their actual usage remains in snapshot.consumed.
  if (expiresAt.getTime() <= now) return []
  return operation.state === "settled"
    ? [{...identity, expiresAt, state: "settled", actualUnits: operation.actualUnits}]
    : [{...identity, expiresAt, state: "cancelled"}]
}
