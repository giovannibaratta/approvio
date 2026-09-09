import {TaskEither} from "fp-ts/TaskEither"
// TODO: Why the domain is defininf the TransactionError ? Are these errors actually used in the domains ? Seems strange and wrongly doing.
import {TenantContext, TransactionError} from "@domain"

export const TRANSACTION_MANAGER_TOKEN = "TRANSACTION_MANAGER_TOKEN"

export type TransactionIsolationLevel = "ReadCommitted" | "RepeatableRead" | "Serializable"

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel
}

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

// TODO: What is the point of this aliasing. we should just use the new one.
export type TransactionManager = TenantTransactionManager
