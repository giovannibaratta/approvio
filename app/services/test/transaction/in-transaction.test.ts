import {randomOrgId} from "@test/organization-id"
import "@utils/matchers"
import {TenantContext} from "@domain"
import {TenantTransactionManager, TransactionError} from "@services/transaction/interfaces"
import {inTransaction} from "@services/transaction/in-transaction"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"

describe("inTransaction", () => {
  const context: TenantContext = {organizationId: randomOrgId()}

  it("should run the TaskEither with the provided tenant context", async () => {
    // Given a transaction manager that runs the supplied computation
    let receivedContext: TenantContext | undefined
    const transactionManager: TenantTransactionManager = {
      execute: <E extends string, A>(
        tenantContext: TenantContext,
        computation: () => TaskEither<E, A>
      ): TaskEither<E | TransactionError, A> => {
        receivedContext = tenantContext
        return computation()
      }
    }

    // When the transaction operator is applied to a successful task
    const result = await pipe(
      TE.right(undefined),
      inTransaction(transactionManager, context, () => TE.right(42))
    )()

    // Expect the context to reach the transaction manager and the result to be preserved
    expect(receivedContext).toEqual(context)
    expect(result).toBeRightOf(42)
  })

  it("should preserve errors returned by the TaskEither", async () => {
    // Given a transaction manager that runs the supplied computation
    const transactionManager: TenantTransactionManager = {
      execute: (_tenantContext, computation) => computation()
    }

    // When the transaction operator receives a failed task
    const result = await pipe(
      TE.right(undefined),
      inTransaction(transactionManager, context, () => TE.left("domain_error"))
    )()

    // Expect it to preserve the failure
    expect(result).toBeLeftOf("domain_error")
  })

  it("should not open the transaction when the preceding task fails", async () => {
    // Given a transaction manager and a failed validation task
    let transactionStarted = false
    let computationCreated = false
    const transactionManager: TenantTransactionManager = {
      execute: (_tenantContext, computation) => {
        transactionStarted = true
        return computation()
      }
    }

    // When the transaction operator follows the failed task
    const result = await pipe(
      TE.left("validation_error" as const),
      inTransaction(transactionManager, context, () => {
        computationCreated = true
        return TE.right(42)
      })
    )()

    // Expect validation to fail before starting the transaction or creating its computation
    expect(transactionStarted).toBe(false)
    expect(computationCreated).toBe(false)
    expect(result).toBeLeftOf("validation_error")
  })
})
