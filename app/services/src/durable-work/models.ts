import type {TaskGetErrorWebhookTask, TaskGetErrorEmailTask, TaskGetErrorSlackTask} from "../task/interfaces"
import type {EmailError} from "../email/email.interface"
import type {SlackExternalError} from "../slack/interfaces"
import type {HttpError} from "../webhook/interfaces"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {
  isOrganizationId,
  isOriginatingActor,
  isUsageMetric,
  Lease,
  LeaseFactory,
  LeaseValidationError,
  OriginatingActor,
  parseBillingPeriod,
  TenantContext,
  TenantEvent,
  TenantEventFactory,
  TenantEventValidationError,
  UsageMetric
} from "@domain"
import {Brand, brand, isDate, isObject, isUUIDv7} from "@utils"

declare const _OutboxClaimBrand: unique symbol
declare const _OutboxAppendBrand: unique symbol
declare const _UsageSettlementResultBrand: unique symbol
declare const _UsageOperationBrand: unique symbol
declare const _UsageSettlementBrand: unique symbol
declare const _UsageCacheSnapshotBrand: unique symbol
declare const _DispatchClaimBrand: unique symbol
declare const _DispatchClaimResultBrand: unique symbol
declare const _DispatchCompletionBrand: unique symbol
declare const _AuditRecordBrand: unique symbol

interface OutboxAppendData {
  readonly event: TenantEvent
  readonly createdAt: Date
  /** Earliest time the relay may claim this event for delivery. Defaults to creation time. */
  readonly availableAt: Date
  readonly attempts: 0
}

export type OutboxAppend = Brand<OutboxAppendData, typeof _OutboxAppendBrand>

export class OutboxAppendFactory {
  static create(event: TenantEvent, availableAt?: Date): OutboxAppend {
    const createdAt = new Date()
    return brand<OutboxAppendData, typeof _OutboxAppendBrand>({
      event,
      createdAt,
      availableAt: availableAt ?? createdAt,
      attempts: 0
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

type UsageSettlementResultData =
  {readonly state: "settled"; readonly actualUnits: number} | {readonly state: "cancelled"}

export type UsageSettlementResult = Brand<UsageSettlementResultData, typeof _UsageSettlementResultBrand>
export type UsageSettlementResultValidationError =
  "usage_settlement_malformed_object" | "invalid_settlement_state" | "invalid_actual_units"

export class UsageSettlementResultFactory {
  static validate(data: unknown): Either<UsageSettlementResultValidationError, UsageSettlementResult> {
    if (!isObject(data)) return left("usage_settlement_malformed_object")
    if (data.state === "settled") {
      if (!isQuantity(data.actualUnits)) return left("invalid_actual_units")
      return right(
        brand<UsageSettlementResultData, typeof _UsageSettlementResultBrand>({
          state: "settled",
          actualUnits: data.actualUnits
        })
      )
    }
    if (data.state !== "cancelled") return left("invalid_settlement_state")
    if (data.actualUnits !== undefined && data.actualUnits !== null) return left("invalid_actual_units")
    return right(brand<UsageSettlementResultData, typeof _UsageSettlementResultBrand>({state: "cancelled"}))
  }
}

interface UsageOperationData extends TenantContext {
  readonly operationId: string
  readonly metric: UsageMetric
  readonly period: string
  readonly entityType: string
  readonly entityId: string
  readonly actor: OriginatingActor
  readonly estimatedUnits: number
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
  | "invalid_billable_flag"
  | "billing_period_invalid_format"
  | "billing_period_invalid_month"
  | "billing_period_invalid_year"

export class UsageOperationFactory {
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
    if (!isQuantity(data.estimatedUnits)) return left("invalid_estimated_units")
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
        isBillable: data.isBillable
      })
    )
  }
}

type UsageSettlementData = UsageOperation & {readonly revision: string} & (
    {readonly state: "settled"; readonly actualUnits: number} | {readonly state: "cancelled"}
  )

export type UsageSettlement = Brand<UsageSettlementData, typeof _UsageSettlementBrand>
export type UsageSettlementValidationError =
  UsageOperationValidationError | "invalid_revision" | "invalid_settlement_state" | "invalid_actual_units"

export class UsageSettlementFactory {
  static validate(data: unknown): Either<UsageSettlementValidationError, UsageSettlement> {
    const operation = UsageOperationFactory.validate(data)
    if (isLeft(operation)) return operation
    if (!isObject(data)) return left("usage_operation_malformed_object")
    if (!isRevision(data.revision)) return left("invalid_revision")
    if (data.state === "settled") {
      if (!isQuantity(data.actualUnits)) return left("invalid_actual_units")
      return right(
        brand<UsageSettlementData, typeof _UsageSettlementBrand>({
          ...operation.right,
          revision: data.revision,
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
        revision: data.revision,
        state: "cancelled"
      })
    )
  }
}

type UsageCacheOperation = {
  readonly operationId: string
  readonly estimatedUnits: number
  readonly revision: string
} & ({readonly state: "settled"; readonly actualUnits: number} | {readonly state: "reserved" | "cancelled"})

interface UsageCacheSnapshotData {
  readonly consumed: number
  readonly operations: ReadonlyArray<UsageCacheOperation>
}

export type UsageCacheSnapshot = Brand<UsageCacheSnapshotData, typeof _UsageCacheSnapshotBrand>
export type UsageCacheSnapshotValidationError =
  | "usage_snapshot_malformed_object"
  | "invalid_consumed_units"
  | "invalid_operation_id"
  | "invalid_estimated_units"
  | "invalid_revision"
  | "invalid_settlement_state"
  | "invalid_actual_units"
  | "duplicate_usage_operation"
  | "usage_snapshot_quantity_overflow"

export class UsageCacheSnapshotFactory {
  static validate(data: unknown): Either<UsageCacheSnapshotValidationError, UsageCacheSnapshot> {
    if (!isObject(data) || !Array.isArray(data.operations)) return left("usage_snapshot_malformed_object")
    if (!isQuantity(data.consumed)) return left("invalid_consumed_units")
    const operations: UsageCacheOperation[] = []
    const ids = new Set<string>()
    let reserved = 0
    for (const operation of data.operations) {
      if (!isObject(operation)) return left("usage_snapshot_malformed_object")
      if (typeof operation.operationId !== "string" || !isUUIDv7(operation.operationId))
        return left("invalid_operation_id")
      if (ids.has(operation.operationId)) return left("duplicate_usage_operation")
      ids.add(operation.operationId)
      if (!isQuantity(operation.estimatedUnits)) return left("invalid_estimated_units")
      if (!isRevision(operation.revision)) return left("invalid_revision")
      const base = {
        operationId: operation.operationId,
        estimatedUnits: operation.estimatedUnits,
        revision: operation.revision
      }
      if (operation.state === "settled") {
        if (!isQuantity(operation.actualUnits)) return left("invalid_actual_units")
        operations.push({...base, state: "settled", actualUnits: operation.actualUnits})
      } else {
        if (operation.state !== "reserved" && operation.state !== "cancelled") return left("invalid_settlement_state")
        if (operation.actualUnits !== undefined && operation.actualUnits !== null) return left("invalid_actual_units")
        if (operation.state === "reserved") reserved += operation.estimatedUnits
        operations.push({...base, state: operation.state})
      }
    }
    if (!Number.isSafeInteger(data.consumed + reserved)) return left("usage_snapshot_quantity_overflow")
    return right(brand<UsageCacheSnapshotData, typeof _UsageCacheSnapshotBrand>({consumed: data.consumed, operations}))
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

type DispatchClaimResultData = ({readonly state: "admitted"} & DispatchClaim) | {readonly state: "parked"}
/**
 * Result of trying to start an internal task attempt. Admitted includes its
 * identity and fenced lease. Parked means the task was paused without creating
 * an attempt; it does not mean the task's unit of work has finished.
 */
export type DispatchClaimResult = Brand<DispatchClaimResultData, typeof _DispatchClaimResultBrand>
export class DispatchClaimResultFactory {
  static validate(data: unknown): Either<DispatchValidationError, DispatchClaimResult> {
    if (!isObject(data)) return left("dispatch_malformed_object")
    if (data.state === "parked")
      return right(brand<DispatchClaimResultData, typeof _DispatchClaimResultBrand>({state: "parked"}))
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
 *
 * Before executing, only failed completion is accepted: the attempt is closed as
 * failed while the work becomes retry_due, since delivery has not started.
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

function isQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
}
