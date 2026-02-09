import {Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"

/**
 * Logs a success message when the provided TaskEither resolves to a Right.
 *
 * This utility function uses `TE.chainFirstIOK` to perform a logging side effect
 * only on success, preserving the original TaskEither's value and type.
 *
 * @param message - The message to be logged upon success.
 * @param context - Optional context string for the NestJS Logger (e.g., the class or function name).
 * @param extractMeta - Optional function to extract metadata from the success value `A` to be included in the log.
 * @returns A function that accepts a `TaskEither<E, A>` and returns the same `TaskEither<E, A>`.
 *
 * @example
 * ```typescript
 * pipe(
 *   TE.right({ id: 1 }),
 *   logSuccess("Entity created", "MyService", (a) => ({ id: a.id }))
 * )
 * ```
 */
export const logSuccess =
  <E, A>(message: string, context?: string, extractMeta?: (a: A) => Record<string, unknown>) =>
  (te: TaskEither<E, A>): TaskEither<E, A> => {
    return pipe(
      te,
      TE.chainFirstIOK(a => () => {
        const meta = extractMeta ? extractMeta(a) : undefined
        if (meta) Logger.log(`${message} ${JSON.stringify(meta)}`, context)
        else Logger.log(message, context)
      })
    )
  }
