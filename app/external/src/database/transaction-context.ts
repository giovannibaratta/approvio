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
 * await txManager.execute(async () => {
 *   // Repositories can access the transaction context like this:
 *   const client = transactionContext.getStore()
 *   await client.user.create(...)
 * })
 * ```
 */
export type TransactionContextData = {
  tx: Prisma.TransactionClient
  isolationLevel: Prisma.TransactionIsolationLevel
}

export const transactionContext = new AsyncLocalStorage<TransactionContextData>()
