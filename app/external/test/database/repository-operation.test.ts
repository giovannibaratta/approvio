import * as E from "fp-ts/Either"
import {Prisma} from "@prisma/client"
import {
  fromPromise,
  fromEitherPromise,
  trackTransactionResult,
  unwrapTransactionResult
} from "../../src/database/repository-operation"

describe("repository operation boundary", () => {
  it("preserves the original Left through rollback", async () => {
    // Given
    const value = E.left("invalid_record")

    // When
    const result = await unwrapTransactionResult(() => trackTransactionResult(() => Promise.resolve(value)))

    // Expect
    expect(result).toBe(value)
  })

  it("returns storage failures as Left outside a transaction", async () => {
    // Given
    const failure = new Error("storage unavailable")

    // When
    const result = await fromPromise(
      () => Promise.reject(failure),
      () => "repository_dependency_error" as const
    )()

    // Expect
    expect(result).toEqual(E.left("repository_dependency_error"))
  })

  it("preserves a domain validation Left", async () => {
    // When
    const result = await fromEitherPromise(
      () => Promise.resolve(E.left("invalid_record" as const)),
      () => "storage_unavailable" as const
    )()

    // Expect
    expect(result).toEqual(E.left("invalid_record"))
  })

  it("returns Left only after the transaction has rolled back", async () => {
    // Given
    let rolledBack = false

    // When
    const result = await unwrapTransactionResult(async () => {
      try {
        return await trackTransactionResult(() => Promise.resolve(E.left("concurrent_modification_error" as const)))
      } catch (error) {
        rolledBack = true
        throw error
      }
    })

    // Expect
    expect(rolledBack).toBe(true)
    expect(result).toEqual(E.left("concurrent_modification_error"))
  })

  it("retains the original serialization cause for the infrastructure retry loop", async () => {
    // Given
    const conflict = new Prisma.PrismaClientKnownRequestError("write conflict", {code: "P2034", clientVersion: "7.9.1"})
    let observed: E.Either<"repository_dependency_error", never> | undefined

    // When
    const result = trackTransactionResult(async () => {
      const left = await fromPromise(
        () => Promise.reject(conflict),
        () => "repository_dependency_error" as const
      )()
      observed = left
      return left
    })

    // Expect
    await expect(result).rejects.toBe(conflict)
    expect(observed).toEqual(E.left("repository_dependency_error"))
  })

  it("isolates failure causes between concurrent transactions", async () => {
    // Given
    // Promise barriers force both transaction scopes to overlap without sleeps:
    // A records a conflict, B completes while A retains it, then A resumes.
    const conflict = new Prisma.PrismaClientKnownRequestError("write conflict", {code: "P2034", clientVersion: "7.9.1"})
    let signalConflictRecorded!: () => void
    const conflictRecorded = new Promise<void>(resolve => {
      signalConflictRecorded = resolve
    })
    let releaseConflictingTransaction!: () => void
    const unrelatedTransactionFinished = new Promise<void>(resolve => {
      releaseConflictingTransaction = resolve
    })

    // When
    const results = await Promise.allSettled([
      trackTransactionResult(async () => {
        const result = await fromPromise(
          () => Promise.reject(conflict),
          () => "repository_dependency_error" as const
        )()
        // fromPromise has saved the original Prisma error in A's async context.
        signalConflictRecorded()
        await unrelatedTransactionFinished
        return result
      }),
      trackTransactionResult(async () => {
        // B must succeed while A's conflict is still retained in its own context.
        await conflictRecorded
        return fromPromise(
          () => Promise.resolve("unrelated transaction"),
          () => "repository_dependency_error" as const
        )()
      }).finally(releaseConflictingTransaction)
    ])

    // Expect
    // A rethrows the original error; B must neither inherit nor clear A's cause.
    expect(results).toEqual([
      {status: "rejected", reason: conflict},
      {status: "fulfilled", value: E.right("unrelated transaction")}
    ])
  })

  it("preserves the conflict when a service converts the Left into a rollback signal", async () => {
    // Given
    const conflict = new Prisma.PrismaClientKnownRequestError("write conflict", {code: "P2034", clientVersion: "7.9.1"})
    const serviceRollback = new Error("service rollback")

    // When
    const result = trackTransactionResult(async () => {
      const operation = await fromPromise(
        () => Promise.reject(conflict),
        () => "repository_dependency_error" as const
      )()
      if (E.isLeft(operation)) throw serviceRollback
      return operation.right
    })

    // Expect
    await expect(result).rejects.toBe(conflict)
  })
})
