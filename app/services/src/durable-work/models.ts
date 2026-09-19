import type {TaskGetErrorWebhookTask, TaskGetErrorEmailTask, TaskGetErrorSlackTask} from "../task/interfaces"
import type {EmailError} from "../email/email.interface"
import type {SlackExternalError} from "../slack/interfaces"
import type {HttpError} from "../webhook/interfaces"
import {Either, chain, isLeft, left, right} from "fp-ts/Either"
import {
  isOrganizationId,
  isOriginatingActor,
  isUsageMetric,
  isUsageQuantity,
  Lease,
  LeaseFactory,
  LeaseValidationError,
  OriginatingActor,
  parseBillingPeriod,
  TenantContext,
  TenantEvent,
  TenantEventFactory,
  TenantEventValidationError,
  UsageMetric,
  UsageSettlementState
} from "@domain"
import {pipe} from "fp-ts/function"
import {Brand, brand, generateDeterministicId, isDate, isObject, isUUIDv7} from "@utils"

declare const _OutboxClaimBrand: unique symbol
declare const _OutboxAppendBrand: unique symbol
declare const _UsageSettlementResultBrand: unique symbol
declare const _UsageOperationBrand: unique symbol
declare const _UsageSettlementBrand: unique symbol
declare const _UsageSnapshotBrand: unique symbol
declare const _DispatchClaimBrand: unique symbol
declare const _DispatchClaimResultBrand: unique symbol
declare const _DispatchCompletionBrand: unique symbol
declare const _AuditRecordBrand: unique symbol

interface OutboxAppendData {
  readonly event: TenantEvent
  readonly createdAt: Date
  /** Earliest time the relay may claim this event for delivery. Defaults to creation time. */
  readonly availableAt: Date
  readonly attempts: 0n
  readonly occ: 0n
}

export type OutboxAppend = Brand<OutboxAppendData, typeof _OutboxAppendBrand>

export class OutboxAppendFactory {
  static create(event: TenantEvent, availableAt?: Date): OutboxAppend {
    const createdAt = new Date()
    return brand<OutboxAppendData, typeof _OutboxAppendBrand>({
      event,
      createdAt,
      availableAt: availableAt ?? createdAt,
      attempts: 0n,
      occ: 0n
    })
  }
}

interface OutboxClaimData {
  readonly event: TenantEvent
  readonly lease: Lease
}

export type OutboxClaim = Brand<OutboxClaimData, typeof _OutboxClaimBrand>
export type OutboxClaimValidationError =
  "outbox_claim_malformed_object" | TenantEventValidationError | LeaseValidationError

export class OutboxClaimFactory {
  static validate(data: unknown): Either<OutboxClaimValidationError, OutboxClaim> {
    if (!isObject(data)) return left("outbox_claim_malformed_object")
    const event = TenantEventFactory.validate(data.event)
    if (isLeft(event)) return event
    const lease = LeaseFactory.validate(data.lease)
    if (isLeft(lease)) return lease
    return right(brand<OutboxClaimData, typeof _OutboxClaimBrand>({event: event.right, lease: lease.right}))
  }
}

export type UsageSettlementResult = Brand<UsageSettlementState, typeof _UsageSettlementResultBrand>
export type UsageSettlementResultValidationError =
  "usage_settlement_malformed_object" | "invalid_settlement_state" | "invalid_actual_units"

export class UsageSettlementResultFactory {
  static validate(data: unknown): Either<UsageSettlementResultValidationError, UsageSettlementResult> {
    if (!isObject(data)) return left("usage_settlement_malformed_object")
    if (data.state === "settled") {
      if (!isUsageQuantity(data.actualUnits)) return left("invalid_actual_units")
      return right(
        brand<UsageSettlementState, typeof _UsageSettlementResultBrand>({
          state: "settled",
          actualUnits: data.actualUnits
        })
      )
    }
    if (data.state !== "cancelled") return left("invalid_settlement_state")
    if (data.actualUnits !== undefined && data.actualUnits !== null) return left("invalid_actual_units")
    return right(brand<UsageSettlementState, typeof _UsageSettlementResultBrand>({state: "cancelled"}))
  }
}

interface UsageOperationData extends TenantContext {
  readonly operationId: string
  readonly metric: UsageMetric
  readonly period: string
  readonly entityType: string
  readonly entityId: string
  readonly actor: OriginatingActor
  readonly estimatedUnits: bigint
  /** Last allowed start time. */
  readonly expiresAt: Date
  readonly isBillable: boolean
}

export type UsageOperation = Brand<UsageOperationData, typeof _UsageOperationBrand>
export type UsageOperationValidationError =
  | "usage_operation_malformed_object"
  | "invalid_organization_id"
  | "invalid_operation_id"
  | "invalid_metric"
  | "invalid_entity_type"
  | "invalid_entity_id"
  | "invalid_actor_id"
  | "invalid_actor"
  | "invalid_estimated_units"
  | "invalid_operation_expires_at"
  | "invalid_billable_flag"
  | "billing_period_invalid_format"
  | "billing_period_invalid_month"
  | "billing_period_invalid_year"

export class UsageOperationFactory {
  static isSameOperation(stored: UsageOperation, requested: UsageOperation): boolean {
    return (
      stored.organizationId === requested.organizationId &&
      stored.operationId === requested.operationId &&
      stored.metric === requested.metric &&
      stored.period === requested.period &&
      stored.entityType === requested.entityType &&
      stored.entityId === requested.entityId &&
      stored.actor.type === requested.actor.type &&
      stored.actor.id === requested.actor.id &&
      stored.actor.displayName === requested.actor.displayName &&
      stored.estimatedUnits === requested.estimatedUnits &&
      stored.isBillable === requested.isBillable &&
      stored.expiresAt.getTime() === requested.expiresAt.getTime()
    )
  }

  static validate(data: unknown): Either<UsageOperationValidationError, UsageOperation> {
    if (!isObject(data)) return left("usage_operation_malformed_object")
    if (!isOrganizationId(data.organizationId)) return left("invalid_organization_id")
    if (typeof data.operationId !== "string" || !isUUIDv7(data.operationId)) return left("invalid_operation_id")
    if (!isUsageMetric(data.metric)) return left("invalid_metric")
    if (typeof data.period !== "string") return left("billing_period_invalid_format")
    const period = parseBillingPeriod(data.period)
    if (isLeft(period)) return period
    if (typeof data.entityType !== "string" || !data.entityType.trim()) return left("invalid_entity_type")
    if (typeof data.entityId !== "string" || !isUUIDv7(data.entityId)) return left("invalid_entity_id")
    if (!isObject(data.actor) || typeof data.actor.id !== "string" || !isUUIDv7(data.actor.id))
      return left("invalid_actor_id")
    if (!isOriginatingActor(data.actor) || !data.actor.displayName.trim()) return left("invalid_actor")
    if (!isUsageQuantity(data.estimatedUnits)) return left("invalid_estimated_units")
    const expiry = validateUsageExpiry(data.expiresAt)
    if (isLeft(expiry)) return expiry
    if (typeof data.isBillable !== "boolean") return left("invalid_billable_flag")

    return right(
      brand<UsageOperationData, typeof _UsageOperationBrand>({
        organizationId: data.organizationId,
        operationId: data.operationId,
        metric: data.metric,
        period: data.period,
        entityType: data.entityType,
        entityId: data.entityId,
        actor: data.actor,
        estimatedUnits: data.estimatedUnits,
        ...expiry.right,
        isBillable: data.isBillable
      })
    )
  }
}

function validateUsageExpiry(value: unknown): Either<"invalid_operation_expires_at", {readonly expiresAt: Date}> {
  if (!isDate(value) || !Number.isFinite(value.getTime())) return left("invalid_operation_expires_at")
  return right({expiresAt: value})
}

function validateUsageCompletion(
  value: unknown
): Either<"invalid_operation_completed_at", {readonly completedAt: Date}> {
  if (!isDate(value) || !Number.isFinite(value.getTime())) return left("invalid_operation_completed_at")
  return right({completedAt: value})
}

type UsageSettlementData = UsageOperation & UsageSettlementState

export type UsageSettlement = Brand<UsageSettlementData, typeof _UsageSettlementBrand>
export type UsageSettlementValidationError =
  UsageOperationValidationError | "invalid_settlement_state" | "invalid_actual_units"

export class UsageSettlementFactory {
  // TODO: I don't think compelte is a good name. What does it mean that if reserved we return the same output ?
  // we are not actually changing anything.
  // TODO: Is the last return undefined safe, should we invert. Also what does undefined mean in this context ?
  static complete(
    current: UsageOperationRecord,
    result: UsageSettlementResult
  ): Either<UsageSettlementValidationError | "operation_mismatch", UsageSettlement | undefined> {
    if (current.state === "reserved") return this.validate({...current, ...result})
    if (current.state !== result.state) return left("operation_mismatch")
    if (current.state === "settled" && result.state === "settled" && current.actualUnits !== result.actualUnits)
      return left("operation_mismatch")
    return right(undefined)
  }

  static toEvent(settlement: UsageSettlement): Either<TenantEventValidationError, TenantEvent> {
    return TenantEventFactory.validate({
      organizationId: settlement.organizationId,
      schemaVersion: 1,
      // TODO: What does the last -1 mean ?
      // Preserve the original identity suffix for the single immutable settlement per operation.
      eventId: generateDeterministicId(`usage-settlement-${settlement.organizationId}-${settlement.operationId}-1`),
      type: "usage.settlement",
      operationId: settlement.operationId
    })
  }

  static validate(data: unknown): Either<UsageSettlementValidationError, UsageSettlement> {
    const operation = UsageOperationFactory.validate(data)
    if (isLeft(operation)) return operation
    if (!isObject(data)) return left("usage_operation_malformed_object")
    if (data.state === "settled") {
      if (!isUsageQuantity(data.actualUnits)) return left("invalid_actual_units")
      return right(
        brand<UsageSettlementData, typeof _UsageSettlementBrand>({
          ...operation.right,
          state: "settled",
          actualUnits: data.actualUnits
        })
      )
    }
    if (data.state !== "cancelled") return left("invalid_settlement_state")
    if (data.actualUnits !== undefined && data.actualUnits !== null) return left("invalid_actual_units")
    return right(
      brand<UsageSettlementData, typeof _UsageSettlementBrand>({
        ...operation.right,
        state: "cancelled"
      })
    )
  }
}

export type UsageOperationStateSnapshot = {
  readonly operationId: string
  readonly estimatedUnits: bigint
  readonly expiresAt: Date
} & (
  | {readonly state: "reserved"}
  | {readonly state: "settled"; readonly actualUnits: bigint; readonly completedAt: Date}
  | {readonly state: "cancelled"; readonly completedAt: Date}
)

/** Persisted lifecycle and OCC accompany the immutable operation facts. */
export type UsageOperationRecord = UsageOperation & UsageOperationStateSnapshot & {readonly occ: bigint}

interface UsageSnapshotData {
  readonly consumed: bigint
  readonly operations: ReadonlyArray<UsageOperationStateSnapshot>
}

export type UsageSnapshot = Brand<UsageSnapshotData, typeof _UsageSnapshotBrand>
export type UsageSnapshotValidationError =
  | "usage_snapshot_malformed_object"
  | "invalid_consumed_units"
  | "invalid_operation_id"
  | "invalid_estimated_units"
  | "invalid_settlement_state"
  | "invalid_actual_units"
  | "duplicate_usage_operation"
  | "usage_snapshot_quantity_overflow"
  | "invalid_operation_expires_at"
  | "invalid_operation_completed_at"

export class UsageSnapshotFactory {
  static validate(data: unknown): Either<UsageSnapshotValidationError, UsageSnapshot> {
    if (!isObject(data) || !Array.isArray(data.operations)) return left("usage_snapshot_malformed_object")
    if (!isUsageQuantity(data.consumed)) return left("invalid_consumed_units")
    const consumed = data.consumed
    return pipe(
      this.validateOperations(data.operations),
      chain(operations => {
        const reserved = operations.reduce(
          (total, operation) => total + (operation.state === "reserved" ? operation.estimatedUnits : 0n),
          0n
        )
        if (!isUsageQuantity(consumed + reserved)) return left("usage_snapshot_quantity_overflow")
        return right(brand<UsageSnapshotData, typeof _UsageSnapshotBrand>({consumed, operations}))
      })
    )
  }

  static validateOperation(data: unknown): Either<UsageSnapshotValidationError, UsageOperationStateSnapshot> {
    if (!isObject(data)) return left("usage_snapshot_malformed_object")
    if (typeof data.operationId !== "string" || !isUUIDv7(data.operationId)) return left("invalid_operation_id")
    if (!isUsageQuantity(data.estimatedUnits)) return left("invalid_estimated_units")
    const expiry = validateUsageExpiry(data.expiresAt)
    if (isLeft(expiry)) return expiry
    const base = {
      operationId: data.operationId,
      estimatedUnits: data.estimatedUnits,
      ...expiry.right
    }
    if (data.state === "reserved") {
      if (data.actualUnits !== undefined && data.actualUnits !== null) return left("invalid_actual_units")
      if (data.completedAt !== undefined) {
        const completion = validateUsageCompletion(data.completedAt)
        if (isLeft(completion)) return completion
      }
      return right({...base, state: "reserved"})
    }
    if (data.state !== "settled" && data.state !== "cancelled") return left("invalid_settlement_state")
    const completion = validateUsageCompletion(data.completedAt)
    if (isLeft(completion)) return completion
    if (data.state === "settled") {
      if (!isUsageQuantity(data.actualUnits)) return left("invalid_actual_units")
      return right({...base, ...completion.right, state: "settled", actualUnits: data.actualUnits})
    }
    if (data.actualUnits !== undefined && data.actualUnits !== null) return left("invalid_actual_units")
    return right({...base, ...completion.right, state: "cancelled"})
  }

  static validateOperations(
    data: unknown
  ): Either<UsageSnapshotValidationError, ReadonlyArray<UsageOperationStateSnapshot>> {
    if (!Array.isArray(data)) return left("usage_snapshot_malformed_object")
    const operations: UsageOperationStateSnapshot[] = []
    const ids = new Set<string>()
    let reserved = 0n
    for (const value of data) {
      const result = this.validateOperation(value)
      if (isLeft(result)) return result
      const operation = result.right
      if (ids.has(operation.operationId)) return left("duplicate_usage_operation")
      ids.add(operation.operationId)
      if (operation.state === "reserved") reserved += operation.estimatedUnits
      operations.push(operation)
    }
    if (!isUsageQuantity(reserved)) return left("usage_snapshot_quantity_overflow")
    return right(operations)
  }
}

/**
 * Handle returned to a worker after claiming one internal execution attempt.
 * attemptId and occ identify the newly persisted dispatch_attempts record; the
 * fenced lease combines the task's durable_work ownership with the attempt's
 * fence.
 */
interface DispatchClaimData {
  readonly attemptId: string
  readonly lease: Lease
  readonly occ: bigint
}

export type DispatchClaim = Brand<DispatchClaimData, typeof _DispatchClaimBrand>
export type DispatchValidationError =
  | LeaseValidationError
  | "dispatch_malformed_object"
  | "dispatch_invalid_attempt_id"
  | "dispatch_invalid_occ"
  | "dispatch_invalid_state"
  | "dispatch_invalid_http_status"

export class DispatchClaimFactory {
  static validate(data: unknown): Either<DispatchValidationError, DispatchClaim> {
    if (!isObject(data)) return left("dispatch_malformed_object")
    if (typeof data.attemptId !== "string" || !isUUIDv7(data.attemptId)) return left("dispatch_invalid_attempt_id")
    if (typeof data.occ !== "bigint") return left("dispatch_invalid_occ")
    const lease = LeaseFactory.validate(data.lease)
    if (isLeft(lease)) return lease
    return right(
      brand<DispatchClaimData, typeof _DispatchClaimBrand>({
        attemptId: data.attemptId,
        lease: lease.right,
        occ: data.occ
      })
    )
  }
}

type DispatchClaimResultData = ({readonly state: "admitted"} & DispatchClaim) | {readonly state: "parked" | "completed"}
/**
 * Result of trying to start an internal task attempt. Admitted includes its
 * identity and fenced lease. Parked means the task was paused without creating
 * an attempt; it does not mean the task's unit of work has finished. Completed
 * means delivery already succeeded and no new attempt is needed.
 */
export type DispatchClaimResult = Brand<DispatchClaimResultData, typeof _DispatchClaimResultBrand>
export class DispatchClaimResultFactory {
  static validate(data: unknown): Either<DispatchValidationError, DispatchClaimResult> {
    if (!isObject(data)) return left("dispatch_malformed_object")
    if (data.state === "parked" || data.state === "completed")
      return right(brand<DispatchClaimResultData, typeof _DispatchClaimResultBrand>({state: data.state}))
    if (data.state !== "admitted") return left("dispatch_invalid_state")
    const claim = DispatchClaimFactory.validate(data)
    if (isLeft(claim)) return claim
    return right(brand<DispatchClaimResultData, typeof _DispatchClaimResultBrand>({...claim.right, state: "admitted"}))
  }
}

type TaskLoadError = TaskGetErrorWebhookTask | TaskGetErrorEmailTask | TaskGetErrorSlackTask
type DeliveryError = EmailError | SlackExternalError | HttpError

/** Delivery observation for one attempt; the completion state describes how it is handled. */
export type DispatchOutcome =
  | {readonly type: "delivered"}
  | {readonly type: "http_response"; readonly statusCode: number}
  | {readonly type: "task_load_failed"; readonly error: TaskLoadError}
  | {readonly type: "delivery_error"; readonly error: DeliveryError}

/**
 * Completion of one internal dispatch attempt, not necessarily completion of
 * the task's entire unit of work. Completion records the outcome, closes the
 * attempt with completedAt, and releases its lease.
 *
 * - succeeded: delivery succeeded.
 * - retry_due: this attempt ended, but the task still needs another attempt.
 * - failed: this attempt failed; after executing, the work is also marked failed.
 * - unknown: delivery could not be confirmed. Work remains unknown; webhook
 *   work can be claimed again using the immutable task ID for deduplication.
 *
 * For an executing attempt, the state is written to both the attempt and the work.
 * Thus retry_due on a completed attempt describes the need for a subsequent
 * attempt, not an attempt that is still running. A later claim creates a new
 * attemptId and advances the lease fence. No event receipt is recorded for a
 * retry_due completion, leaving the event eligible for further processing.
 * Confirmed success is committed before its receipt is attempted separately:
 * a missing event or failed receipt write must not erase a confirmed delivery.
 *
 * Before executing, only failed completion is accepted: the attempt is closed as
 * failed. The external adapter supplies the task-load error code and retryability;
 * dispatch retains retry_due only when the adapter marks the failure retryable.
 * The completion model records a disposition; it does not schedule a queue job
 * or define a retry delay.
 */
interface DispatchCompletionData {
  readonly state: "succeeded" | "retry_due" | "failed" | "unknown"
  readonly outcome: DispatchOutcome
}

export type DispatchCompletion = Brand<DispatchCompletionData, typeof _DispatchCompletionBrand>
export class DispatchCompletionFactory {
  static validate(data: DispatchCompletionData): Either<DispatchValidationError, DispatchCompletion> {
    const outcome = data.outcome
    if (
      outcome.type === "http_response" &&
      (!Number.isInteger(outcome.statusCode) || outcome.statusCode < 100 || outcome.statusCode > 599)
    )
      return left("dispatch_invalid_http_status")
    return right(brand<DispatchCompletionData, typeof _DispatchCompletionBrand>({state: data.state, outcome}))
  }
}

interface AuditRecordData extends TenantContext {
  readonly id: string
  readonly actor: OriginatingActor
  readonly entityType: string
  readonly entityId: string
  readonly action: string
  readonly occurredAt: Date
  readonly payload: Readonly<Record<string, unknown>>
}

export type AuditRecord = Brand<AuditRecordData, typeof _AuditRecordBrand>
export type AuditRecordValidationError =
  | "audit_record_malformed_object"
  | "invalid_organization_id"
  | "audit_record_invalid_id"
  | "invalid_actor_id"
  | "invalid_actor"
  | "invalid_entity_type"
  | "invalid_entity_id"
  | "audit_record_invalid_action"
  | "audit_record_invalid_occurred_at"
  | "audit_record_invalid_payload"

export class AuditRecordFactory {
  static validate(data: unknown): Either<AuditRecordValidationError, AuditRecord> {
    if (!isObject(data)) return left("audit_record_malformed_object")
    if (!isOrganizationId(data.organizationId)) return left("invalid_organization_id")
    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return left("audit_record_invalid_id")
    if (!isObject(data.actor) || typeof data.actor.id !== "string" || !isUUIDv7(data.actor.id))
      return left("invalid_actor_id")
    if (!isOriginatingActor(data.actor) || !data.actor.displayName.trim()) return left("invalid_actor")
    if (typeof data.entityType !== "string" || !data.entityType.trim()) return left("invalid_entity_type")
    if (typeof data.entityId !== "string" || !isUUIDv7(data.entityId)) return left("invalid_entity_id")
    if (typeof data.action !== "string" || !data.action.trim()) return left("audit_record_invalid_action")
    if (!isDate(data.occurredAt) || !Number.isFinite(data.occurredAt.getTime()))
      return left("audit_record_invalid_occurred_at")
    if (!isObject(data.payload)) return left("audit_record_invalid_payload")
    return right(
      brand<AuditRecordData, typeof _AuditRecordBrand>({
        organizationId: data.organizationId,
        id: data.id,
        actor: data.actor,
        entityType: data.entityType,
        entityId: data.entityId,
        action: data.action,
        occurredAt: data.occurredAt,
        payload: data.payload
      })
    )
  }
}
