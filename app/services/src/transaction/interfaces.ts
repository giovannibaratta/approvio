import {TaskEither} from "fp-ts/TaskEither"
import {BoundaryError, TenantContext} from "@domain"

// TODO(long-term): this is a partial permission model leak of the external layer.
// We should have separate deployments method for the various components and partition
// the services in a better way.
export const TRANSACTION_MANAGER_TOKEN = "TRANSACTION_MANAGER_TOKEN"
export const WORKER_TRANSACTION_MANAGER_TOKEN = "WORKER_TRANSACTION_MANAGER_TOKEN"

export type TransactionIsolationLevel = "ReadCommitted" | "RepeatableRead" | "Serializable"

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel
}

/** Infrastructure failures returned by the transaction boundary. */
export type TransactionError =
  | BoundaryError
  | "conflicting_isolation_level"
  | "retry_exhausted"
  | "commit_outcome_unknown"
  | "storage_unavailable"
  | "concurrency_error"

export type ExecutionError = TransactionError

/**
 * Runs database-only work under one transaction-local tenant context.
 * Implementations reject cross-organization nesting and conflicting isolation levels.
 */
export interface TenantTransactionManager {
  execute<E extends string, T>(
    context: TenantContext,
    computation: () => TaskEither<E, T>,
    options?: TransactionOptions
  ): TaskEither<E | TransactionError, T>
}
