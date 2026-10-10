import {AsyncLocalStorage} from "node:async_hooks"
import {Prisma} from "@prisma/client"

/**
 * AsyncLocalStorage instance for managing transaction context.
 *
 * This allows us to store the current transaction client in a way that is
 * accessible throughout the call stack without passing it explicitly as a parameter.
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
  organizationId: string
  isolationLevel: Prisma.TransactionIsolationLevel
  runtimeRole: "approvio_tenant_runtime" | "approvio_worker_runtime"
}

export const transactionContext = new AsyncLocalStorage<TransactionContextData>()
