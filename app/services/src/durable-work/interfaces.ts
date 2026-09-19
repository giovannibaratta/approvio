import {DispatchWork, DispatchAttemptSnapshot, DispatchTransition} from "./dispatch.models"
export * from "./dispatch.models"
import {Option} from "fp-ts/Option"
import {TaskEither} from "fp-ts/TaskEither"
import {
  BoundaryError,
  Lease,
  TaskKind,
  TenantContext,
  TenantEvent,
  TenantEventValidationError,
  UsageMetric,
  LeaseValidationError
} from "@domain"

import {TransactionError} from "../transaction/interfaces"

import {
  OutboxAppend,
  OutboxClaim,
  OutboxClaimValidationError,
  UsageSettlementResult,
  UsageSettlementResultValidationError,
  AuditRecord,
  DispatchValidationError,
  UsageOperation,
  UsageSettlement,
  UsageCacheSnapshot,
  UsageOperationValidationError,
  UsageSettlementValidationError,
  UsageCacheSnapshotValidationError
} from "./models"
export * from "./models"

export type WorkError =
  | "capacity_exceeded"
  | "dispatch_lease_invalid_response"
  | "invalid_batch_size"
  | "outbox_publication_state_invalid"
  | OutboxClaimValidationError
  | DispatchValidationError
  | LeaseValidationError
  | TransactionError
  | "organization_not_found"
  | "organization_deleting"
  | BoundaryError
  | "task_not_found"
  | "lease_lost"
  | "invalid_transition"
  | "event_mismatch"
  | "organization_suspended"
  | "repository_dependency_error"

export const OUTBOX_REPOSITORY_TOKEN = Symbol("OUTBOX_REPOSITORY_TOKEN")
export const DISPATCH_LEASE_CLIENT_TOKEN = Symbol("DISPATCH_LEASE_CLIENT_TOKEN")
export const DISPATCH_REPOSITORY_TOKEN = Symbol("DISPATCH_REPOSITORY_TOKEN")
export const EVENT_RECEIPT_REPOSITORY_TOKEN = Symbol("EVENT_RECEIPT_REPOSITORY_TOKEN")

export interface EventReceiptRepository {
  record(
    context: TenantContext,
    consumer: "recalculation" | "task_generation" | "task_dispatch" | "lifecycle" | "usage",
    eventId: string
  ): TaskEither<BoundaryError | "event_mismatch" | "repository_dependency_error", "new" | "duplicate">
}

export type OutboxPublicationState =
  | {readonly state: "pending"}
  | {readonly state: "leased"; readonly owner: string; readonly expiresAt: Date}
  | {readonly state: "published"; readonly publishedAt: Date}

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

export interface OutboxRepository {
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
  /** Runs inside the service-owned worker transaction. */
  getPublicationState(context: TenantContext, eventId: string): TaskEither<WorkError, Option<OutboxPublicationState>>
  /** Uses the service-owned worker transaction; updates only unpublished rows with no lease. */
  tryMarkPublished(context: TenantContext, eventId: string, publishedAt: Date): TaskEither<WorkError, boolean>
  /**
   * Runs inside the service-owned worker transaction. A validation Left rolls back the batch.
   * Atomically claims eligible rows in availability/id order, up to batchSize.
   * The service supplies validated inputs, lease expiry and recovery policy.
   * Published events qualify only when the specified consumer receipt is absent.
   * Competing claims may produce a smaller batch. Each claim increments its fence.
   */
  claim(context: TenantContext, criteria: OutboxClaimCriteria): TaskEither<WorkError, ReadonlyArray<OutboxClaim>>
  /** Uses the service-owned worker transaction; false means the fenced update did not match. */
  acknowledge(
    context: TenantContext,
    eventId: string,
    acknowledgement: {readonly owner: string; readonly fencing: number; readonly acknowledgedAt: Date}
  ): TaskEither<WorkError, boolean>
}

/** Reads dispatch snapshots and persists guarded transitions in the service-owned transaction. */
export interface DispatchRepository {
  getWork(context: TenantContext, taskId: string, kind?: TaskKind): TaskEither<WorkError, DispatchWork>
  getAttempt(
    context: TenantContext,
    selector: {readonly attemptId: string} | {readonly taskId: string; readonly fencing: bigint}
  ): TaskEither<WorkError, Option<DispatchAttemptSnapshot>>
  countActive(context: TenantContext, now: Date): TaskEither<WorkError, number>
  persistTransition(context: TenantContext, transition: DispatchTransition): TaskEither<WorkError, void>
  /** Inserts a receipt only if its outbox FK target still exists; old Bull jobs may outlive it. */
  recordReceipt(context: TenantContext, eventId: string): TaskEither<WorkError, void>
}

export type UsageError =
  | "event_mismatch"
  | UsageSettlementResultValidationError
  | UsageOperationValidationError
  | UsageSettlementValidationError
  | UsageCacheSnapshotValidationError
  | BoundaryError
  | "quota_exceeded"
  | "operation_mismatch"
  | "invalid_transition"
  | "invalid_usage"
  | "invalid_batch_size"
  | "repository_dependency_error"

export interface TenantAuditRepository {
  append(context: TenantContext, record: AuditRecord): TaskEither<BoundaryError | "event_mismatch", void>
}

export interface DispatchLeaseClient {
  acquire(context: TenantContext, taskId: string, owner: string): TaskEither<WorkError | "capacity_exceeded", Lease>
  renew(context: TenantContext, taskId: string, lease: Lease): TaskEither<WorkError, Lease>
  release(context: TenantContext, taskId: string, lease: Lease): TaskEither<WorkError, void>
}

export interface UsageOperationRepository {
  /** Reads durable usage totals and operation states from PostgreSQL for reporting or cache recovery. */
  getUsageSnapshot(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TaskEither<UsageError, UsageCacheSnapshot>
  get(context: TenantContext, operationId: string): TaskEither<UsageError, UsageOperation>
  reserve(input: UsageOperation): TaskEither<UsageError, "new" | "duplicate">
  /** Settles or cancels a reservation and records its settlement intent; identical replays return no event. */
  completeOperation(
    input: UsageOperation,
    result: UsageSettlementResult
  ): TaskEither<UsageError, TenantEvent | undefined>
  /** Reads reserved operations ordered by creation time then ID, without claiming them. */
  getReservedOperations(context: TenantContext, limit: number): TaskEither<UsageError, ReadonlyArray<UsageOperation>>
  getSettlement(context: TenantContext, operationId: string, revision: string): TaskEither<UsageError, UsageSettlement>
  /** Reads at most batchSize unacknowledged tenant settlements, ordered by availableAt then ID; does not claim them. */
  getPendingSettlements(
    context: TenantContext,
    batchSize: number
  ): TaskEither<UsageError, ReadonlyArray<UsageSettlement>>
  acknowledge(context: TenantContext, operationId: string, revision: string): TaskEither<UsageError, void>
}

export const USAGE_OPERATION_REPOSITORY_TOKEN = Symbol("USAGE_OPERATION_REPOSITORY_TOKEN")
