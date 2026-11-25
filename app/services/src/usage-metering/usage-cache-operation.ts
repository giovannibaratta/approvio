import {UsageQuotaLimit} from "@domain"
import {UsageSettlementResult} from "../durable-work/models"

export const USAGE_REPLAY_RETENTION_MS = 48 * 60 * 60 * 1000
export const MINIMUM_USAGE_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000

interface UsageCacheOperationIdentity {
  readonly operationId: string
  readonly estimatedUnits: bigint
  /** Last allowed start time. */
  readonly admissionExpiresAt: Date
}

export type UsageCacheHold = UsageCacheOperationIdentity &
  ({readonly state: "reserved"} | {readonly state: "pending_admission"})

export type UsageCacheCompletion = UsageCacheOperationIdentity &
  (
    | {readonly state: "settled"; readonly actualUnits: bigint; readonly expiresAt: Date}
    | {readonly state: "cancelled"; readonly expiresAt: Date}
  )

export type UsageCacheOperation = UsageCacheHold | UsageCacheCompletion

export type UsageCacheReservation = UsageCacheOperationIdentity & {
  readonly state: "reserved"
  readonly limit: UsageQuotaLimit
}

export interface UsageCacheSettlement {
  readonly operation: UsageCacheCompletion
  /** End of the window during which retries require an individual completed-operation record. */
  readonly replayWindowEndsAt: Date
  readonly minimumCacheExpiresAt: Date
}

/** Prepares operation facts and retention deadlines for admission and settlement. */
export class UsageCacheOperationFactory {
  static reserve(
    operationId: string,
    limit: UsageQuotaLimit,
    estimate: bigint,
    expiresAt: Date
  ): UsageCacheReservation {
    return {
      operationId,
      state: "reserved",
      limit,
      estimatedUnits: estimate,
      admissionExpiresAt: expiresAt
    }
  }

  static settle(
    operationId: string,
    estimate: bigint,
    result: UsageSettlementResult,
    expiresAt: Date
  ): UsageCacheSettlement {
    const now = Date.now()
    const identity = {
      operationId,
      estimatedUnits: estimate,
      admissionExpiresAt: expiresAt,
      expiresAt: new Date(Math.max(expiresAt.getTime(), now) + USAGE_REPLAY_RETENTION_MS)
    }
    const operation: UsageCacheCompletion =
      result.state === "settled"
        ? {...identity, state: "settled", actualUnits: result.actualUnits}
        : {...identity, state: "cancelled"}
    return {
      operation,
      replayWindowEndsAt: new Date(expiresAt.getTime() + USAGE_REPLAY_RETENTION_MS),
      minimumCacheExpiresAt: new Date(now + MINIMUM_USAGE_CACHE_RETENTION_MS)
    }
  }
}
