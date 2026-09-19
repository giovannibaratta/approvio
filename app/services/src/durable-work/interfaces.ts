import {
  DispatchWork,
  DispatchAttempt,
  DispatchWorkValidationError,
  DispatchAttemptValidationError,
  DispatchTransitionError
} from "./dispatch.models"
export * from "./dispatch.models"
import {Option} from "fp-ts/Option"
import {TaskEither} from "fp-ts/TaskEither"
import {
  BoundaryError,
  DeliveryPermit,
  DeliveryPermitValidationError,
  TenantContext,
  TenantEvent,
  TenantEventValidationError,
  UsageMetric,
  Versioned,
  LeaseValidationError,
  OutboxPublicationState,
  OutboxPublicationStateValidationError
} from "@domain"

import {TransactionError} from "../transaction/interfaces"

import {
  OutboxAppend,
  OutboxClaim,
  OutboxClaimValidationError,
  UsageSettlementResultValidationError,
  AuditRecord,
  DispatchValidationError,
  UsageOperation,
  UsageOperationRecord,
  UsageSettlement,
  UsageOperationStateSnapshot,
  UsageOperationValidationError,
  UsageSettlementValidationError,
  UsageSnapshotValidationError
} from "./models"
export * from "./models"

export type WorkError =
  | "capacity_exceeded"
  | "delivery_permit_invalid_response"
  | "delivery_permit_held_by_another_owner"
  | "delivery_permit_state_inconsistent"
  | DeliveryPermitValidationError
  | "invalid_batch_size"
  | OutboxPublicationStateValidationError
  | OutboxClaimValidationError
  | DispatchValidationError
  | DispatchWorkValidationError
  | DispatchAttemptValidationError
  | DispatchTransitionError
  | LeaseValidationError
  | TransactionError
  | "organization_not_found"
  | "organization_deleting"
  | BoundaryError
  | "task_not_found"
  | "lease_lost"
  | "dispatch_recovery_already_unknown"
  | "dispatch_recovery_not_applicable"
  | "dispatch_work_already_paused"
  | "dispatch_attempt_not_found"
  | "dispatch_attempt_concurrent_modification"
  | "dispatch_inconsistent_state"
  | "event_mismatch"
  | "event_not_found"
  | "organization_suspended"
  | "repository_dependency_error"

export const WORKER_OUTBOX_REPOSITORY_TOKEN = Symbol("WORKER_OUTBOX_REPOSITORY_TOKEN")
export const TENANT_OUTBOX_REPOSITORY_TOKEN = Symbol("TENANT_OUTBOX_REPOSITORY_TOKEN")
export const DELIVERY_CONCURRENCY_LIMITER_TOKEN = Symbol("DELIVERY_CONCURRENCY_LIMITER_TOKEN")
export const DISPATCH_REPOSITORY_TOKEN = Symbol("DISPATCH_REPOSITORY_TOKEN")
export const EVENT_RECEIPT_REPOSITORY_TOKEN = Symbol("EVENT_RECEIPT_REPOSITORY_TOKEN")

export type EventReceiptConsumer = "recalculation" | "task_generation" | "task_dispatch" | "lifecycle" | "usage"

export interface EventReceiptRepository {
  /**
   * Inserts a consumer receipt idempotently in the active tenant transaction.
   * Returns duplicate for an existing receipt, or event_not_found if its outbox
   * parent is missing.
   */
  record(
    context: TenantContext,
    consumer: EventReceiptConsumer,
    eventId: string
  ): TaskEither<BoundaryError | "event_not_found" | "repository_dependency_error", "new" | "duplicate">
}

export interface OutboxClaimCriteria {
  readonly owner: string
  readonly claimAt: Date
  readonly recoveryBefore: Date
  readonly leaseUntil: Date
  readonly batchSize: number
  readonly receiptRecovery: ReadonlyArray<{
    readonly eventType: TenantEvent["type"]
    readonly consumer: "recalculation" | "task_generation" | "task_dispatch" | "lifecycle" | "usage"
  }>
}

export interface TenantOutboxRepository {
  /** Runs inside TenantTransactionManager.execute, which returns retry exhaustion as a Left. */
  getEvent(
    context: TenantContext,
    eventId: string
  ): TaskEither<
    BoundaryError | "event_not_found" | "event_mismatch" | TenantEventValidationError | "repository_dependency_error",
    TenantEvent
  >
  /** Shares the caller's transaction; returns false on a duplicate event ID. */
  append(context: TenantContext, input: OutboxAppend): TaskEither<"repository_dependency_error", boolean>
  /** Shares the normal service-owned transaction. */
  getPublicationState(context: TenantContext, eventId: string): TaskEither<WorkError, Option<OutboxPublicationState>>
  /** Uses the normal service-owned transaction; updates only unpublished rows with no lease. */
  tryMarkPublished(context: TenantContext, eventId: string, publishedAt: Date): TaskEither<WorkError, boolean>
}

/** Lease acquisition and fenced publication acknowledgement are worker-only operations. */
export type OutboxClaimCandidate = Versioned<{
  readonly event: TenantEvent
  readonly fencing: bigint
}>

export type OutboxAcknowledgementState = Versioned<{
  // TODO: lease props should be a nested attribute either nullable or fully defined.
  readonly leaseOwner: string | null
  readonly leaseUntil: Date | null
  readonly publishedAt: Date | null
  readonly fencing: bigint
}>

export interface WorkerOutboxRepository {
  /** Reads candidates using the service's recovery criteria, ordered by availability then ID. */
  listClaimCandidates(
    context: TenantContext,
    criteria: OutboxClaimCriteria
  ): TaskEither<WorkError, ReadonlyArray<OutboxClaimCandidate>>
  /** Writes the supplied claim only at the expected OCC; false means a competing write won. */
  tryClaim(context: TenantContext, claim: OutboxClaim, occ: bigint): TaskEither<WorkError, boolean>
  getAcknowledgementState(context: TenantContext, eventId: string): TaskEither<WorkError, OutboxAcknowledgementState>
  /** Writes publication at the expected OCC; false means a competing write won. */
  acknowledge(
    context: TenantContext,
    eventId: string,
    acknowledgement: {readonly occ: bigint; readonly acknowledgedAt: Date}
  ): TaskEither<WorkError, boolean>
}

export type DispatchAttemptSelector =
  | {readonly type: "attempt_id"; readonly attemptId: string}
  | {readonly type: "task_fence"; readonly taskId: string; readonly fencing: bigint}

/**
 * Persistence boundary for a task's durable delivery state and internal attempts.
 * A task represents the entire unit of work and retains its ID across retries.
 * A dispatch attempt represents one execution of that task under a fenced lease.
 * Finishing an attempt may leave the task pending in retry_due.
 */
export interface DispatchRepository {
  /** Reads the task's delivery state across all attempts; taskId is stable across retries. */
  getWork(context: TenantContext, taskId: string): TaskEither<WorkError, DispatchWork>
  /** Reads one internal attempt, identified directly or by the task and its lease fence. */
  getAttempt(context: TenantContext, selector: DispatchAttemptSelector): TaskEither<WorkError, Option<DispatchAttempt>>
  /**
   * Counts this organization's claimed or executing tasks with unexpired leases.
   * concurrent claims may temporarily exceed the
   * limit when cache undercounts. This count is an approximate capacity fallback.
   */
  countActiveTaskLeases(context: TenantContext, evaluateAt: Date): TaskEither<WorkError, number>
  /**
   * Saves work under its original state, OCC, fencing and lease guards, rechecking
   * ownership or expiry at write time. A missed guard returns lease_lost.
   * DispatchService pairs this with the attempt write in its owning transaction.
   */
  compareAndSetWork(context: TenantContext, previous: DispatchWork, next: DispatchWork): TaskEither<WorkError, void>
  /**
   * Inserts an admitted attempt in the service transaction after its work update.
   * An occupied task fence returns dispatch_inconsistent_state: the guarded work
   * update should prevent a normal concurrent claim from reusing that fence.
   */
  createAttempt(context: TenantContext, attempt: DispatchAttempt): TaskEither<WorkError, void>
  /**
   * Saves an attempt under its original state, OCC and fencing guards.
   * A missed guard returns dispatch_attempt_concurrent_modification, causing
   * the service transaction to roll back the preceding work update.
   */
  compareAndSetAttempt(
    context: TenantContext,
    previous: DispatchAttempt,
    next: DispatchAttempt
  ): TaskEither<WorkError, void>
}

export type UsageError =
  | "event_mismatch"
  | UsageSettlementResultValidationError
  | UsageOperationValidationError
  | UsageSettlementValidationError
  | UsageSnapshotValidationError
  | BoundaryError
  | "quota_exceeded"
  | "operation_mismatch"
  | "settlement_not_found"
  | "unsupported_settlement_revision"
  | "invalid_transition"
  | "invalid_usage"
  | "invalid_limit"
  | "invalid_batch_size"
  | "repository_dependency_error"

export interface TenantAuditRepository {
  append(context: TenantContext, record: AuditRecord): TaskEither<BoundaryError | "event_mismatch", void>
}

/**
 * Reserves expiring permits for simultaneous deliveries within an organization.
 * Each permit belongs to one execution; its token identifies the owner,
 * fencing generation and expiry. DispatchService separately guards the persisted task attempt.
 */
export interface DeliveryConcurrencyLimiter {
  acquirePermit(
    context: TenantContext,
    taskId: string,
    owner: string
  ): TaskEither<WorkError | "capacity_exceeded", DeliveryPermit>
  validatePermit(context: TenantContext, taskId: string, permit: DeliveryPermit): TaskEither<WorkError, void>
  releasePermit(context: TenantContext, taskId: string, permit: DeliveryPermit): TaskEither<WorkError, void>
}

export interface UsageOperationRepository {
  /** Reads persisted operation IDs, states, estimates, and settled actual units for a tenant, metric, and billing period. */
  getOperationStates(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TaskEither<UsageError, ReadonlyArray<UsageOperationStateSnapshot>>
  get(context: TenantContext, operationId: string): TaskEither<UsageError, UsageOperationRecord>
  reserve(
    input: UsageOperation,
    creation: {readonly id: string; readonly createdAt: Date}
  ): TaskEither<UsageError, "new" | "duplicate">
  /** Updates only a reserved operation at the supplied OCC in the owning service transaction. */
  compareAndSetOperation(
    previous: UsageOperationRecord,
    settlement: UsageSettlement,
    updatedAt: Date
  ): TaskEither<UsageError | "concurrency_error", void>
  /** Inserts the terminal intent in the same transaction as the operation transition. */
  createSettlementIntent(
    settlement: UsageSettlement,
    creation: {readonly id: string; readonly createdAt: Date; readonly occ: bigint}
  ): TaskEither<UsageError, void>
  /** Reads reserved operations ordered by creation time then ID, without claiming them. */
  getReservedOperations(context: TenantContext, limit: number): TaskEither<UsageError, ReadonlyArray<UsageOperation>>
  getSettlement(context: TenantContext, operationId: string): TaskEither<UsageError, UsageSettlement>
  /** Reads at most batchSize unacknowledged tenant settlements, ordered by availableAt then ID; does not claim them. */
  getPendingSettlements(
    context: TenantContext,
    batchSize: number
  ): TaskEither<UsageError, ReadonlyArray<UsageSettlement>>
  getSettlementApplicationState(
    context: TenantContext,
    operationId: string
  ): TaskEither<UsageError, Versioned<{readonly appliedAt: Date | null}>>
  acknowledge(
    context: TenantContext,
    operationId: string,
    occ: bigint,
    appliedAt: Date
  ): TaskEither<UsageError | "concurrency_error", void>
}

export const USAGE_OPERATION_REPOSITORY_TOKEN = Symbol("USAGE_OPERATION_REPOSITORY_TOKEN")
