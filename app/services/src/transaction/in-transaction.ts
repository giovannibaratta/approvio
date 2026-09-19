import {TenantContext} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {TenantTransactionManager, TransactionError, TransactionOptions} from "./interfaces"

/**
 * Runs a task inside a tenant transaction after the preceding task succeeds.
 */
export const inTransaction =
  <E extends string, A, B>(
    transactionManager: TenantTransactionManager,
    context: TenantContext,
    computation: (value: A) => TaskEither<E, B>,
    options?: TransactionOptions
  ) =>
  <E1 extends string>(previous: TaskEither<E1, A>): TaskEither<E | E1 | TransactionError, B> =>
    pipe(
      previous,
      TE.chainW(value => transactionManager.execute(context, () => computation(value), options))
    )
