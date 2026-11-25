import {AsyncLocalStorage} from "node:async_hooks"
import {Prisma} from "@prisma/client"
import type {DatabaseClient} from "./database-client"

export type OrganizationDatabaseRole = "approvio_tenant_runtime" | "approvio_worker_runtime"

export type GlobalDatabaseRole =
  | "approvio_identity_runtime"
  | "approvio_session_runtime"
  | "approvio_discovery_runtime"
  | "approvio_scheduler_runtime"
  | "approvio_security_runtime"

export type DatabaseRuntimeRole = OrganizationDatabaseRole | GlobalDatabaseRole

export type DatabaseScope = {readonly type: "organization"; readonly organizationId: string} | {readonly type: "global"}

/**
 * AsyncLocalStorage instance for managing transaction context.
 *
 * This allows us to store the current transaction client in a way that is
 * accessible throughout the call stack without passing it explicitly as a parameter.
 * Scope is explicit: global capabilities have no organization ID. The owning client
 * prevents adapters or another connection pool from borrowing this transaction.
 *
 * @example
 * ```typescript
 * // When starting a transaction
 * txManager.execute({organizationId}, () => TE.tryCatch(
 *   async () => transactionContext.getStore()?.tx.user.create(...),
 *   () => "storage_unavailable"
 * ))
 * ```
 */
export type TransactionContextData = {
  tx: Prisma.TransactionClient
  scope: DatabaseScope
  client: DatabaseClient
  isolationLevel: Prisma.TransactionIsolationLevel
  runtimeRole: DatabaseRuntimeRole
}

export const transactionContext = new AsyncLocalStorage<TransactionContextData>()
