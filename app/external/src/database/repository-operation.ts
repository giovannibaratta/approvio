import {AsyncLocalStorage} from "node:async_hooks"
import {Either, isLeft} from "fp-ts/Either"
import {isEither} from "@utils/either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {Prisma} from "@prisma/client"
import {isDriverAdapterError} from "@prisma/driver-adapter-utils"

/**
 * Recognize database-confirmed transaction conflicts from Prisma or its driver adapter.
 * Domain/OCC Lefts and other storage errors do not qualify for infrastructure retry.
 */
export function isRetryableTransactionError(error: unknown): error is Error {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") ||
    (isDriverAdapterError(error) && error.cause.kind === "TransactionWriteConflict")
  )
}

/**
 * Retains the first retryable database conflict for one transaction attempt.
 * Repositories convert rejected database calls into typed Lefts, which deliberately
 * omit driver errors. Without retaining the original cause, DatabaseClient's retry
 * loop would see an ordinary repository failure and could not retry the transaction.
 *
 * DatabaseClient calls trackTransactionResult inside Prisma's transaction callback.
 * Its failures.run creates a fresh store for each attempt; AsyncLocalStorage makes
 * that store available across awaited repository/service calls without threading
 * retry metadata through their contracts. Concurrent attempts have separate stores.
 * Outside that scope, recording a failure does nothing.
 *
 * The cause takes precedence over returned results or service rollback exceptions:
 * it is rethrown inside Prisma's callback to roll back, then reaches the retry loop.
 * This storage retains a cause; DatabaseClient owns the retry policy.
 */
const failures = new AsyncLocalStorage<{cause?: Error}>()

/**
 * Preserve the first recognized conflict before it is mapped to a typed error.
 * The repository task still returns Left; only the owning transaction rethrows it.
 */
export function recordRetryableFailure(error: unknown): void {
  const active = failures.getStore()
  if (active && isRetryableTransactionError(error)) active.cause ??= error
}

/**
 * Wrap an operation that already returns Either, preserving its validation/domain Lefts.
 * Only thrown or rejected failures go through onError and conflict recording; the
 * successful promise's Either is flattened into the resulting TaskEither.
 */
export function fromEitherPromise<E, A>(
  operation: () => Promise<Either<E, A>>,
  onError: (error: unknown) => E
): TE.TaskEither<E, A> {
  return pipe(
    fromPromise(operation, onError),
    TE.chainEitherKW(result => result)
  )
}

/**
 * Lift a promise-returning function into an argument-preserving repository task factory.
 * Calling the factory captures its arguments; the operation runs only when the returned
 * TaskEither is executed, with the same error handling as fromPromise.
 */
export function fromPromiseK<Args extends readonly unknown[], E, A>(
  operation: (...args: Args) => Promise<A>,
  onError: (error: unknown) => E
): (...args: Args) => TE.TaskEither<E, A> {
  return (...args) => fromPromise(() => operation(...args), onError)
}

/**
 * Run a promise-returning operation lazily, returning its value as Right and mapping
 * thrown/rejected failures to Left with onError. Record retryable conflicts before
 * mapping them so the owning transaction can still roll back and retry.
 * onError must return an error value without throwing.
 */
export function fromPromise<E, A>(operation: () => Promise<A>, onError: (error: unknown) => E): TE.TaskEither<E, A> {
  return TE.tryCatch(operation, error => {
    recordRetryableFailure(error)
    return onError(error)
  })
}

/**
 * Carry a returned Left through Prisma's exception-based rollback boundary.
 * unwrapTransactionResult recovers the original result after rollback completes.
 */
class PersistenceResultRollback<A> extends Error {
  constructor(readonly result: A) {
    super("Persistence operation returned Left")
  }
}

/** Only this module creates the private rollback exception, using the transaction's result type. */
function isResultRollback<A>(error: unknown): error is PersistenceResultRollback<A> {
  return error instanceof PersistenceResultRollback
}

/**
 * Run inside Prisma's callback with a fresh failure store for this attempt.
 * Rethrow recorded conflicts for infrastructure retry; otherwise wrap a returned
 * Left in a private exception so Prisma rolls back all prior writes.
 */
export function trackTransactionResult<A>(operation: () => Promise<A>): Promise<A> {
  return failures.run({}, async () => {
    const active = failures.getStore()
    try {
      const result = await operation()
      if (active?.cause !== undefined) throw active.cause
      if (isEither(result) && isLeft(result)) throw new PersistenceResultRollback(result)
      return result
    } catch (error) {
      // A service may have turned the repository Left into its own rollback signal.
      if (active?.cause !== undefined) throw active.cause
      throw error
    }
  })
}

/**
 * Run around Prisma's transaction promise, restoring typed Lefts only after rollback.
 * Original database conflicts and other exceptions remain rejected so DatabaseClient
 * can apply its retry policy before the outer service boundary maps them.
 */
export async function unwrapTransactionResult<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation()
  } catch (error) {
    if (isResultRollback<A>(error)) return error.result
    throw error
  }
}
