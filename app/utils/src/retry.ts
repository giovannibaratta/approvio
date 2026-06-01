import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"

export interface RetryConfig {
  maxAttempts: number
  initialDelayMs: number
  backoffFactor: number
  maxDelayMs: number
}

const delayTaskEither =
  <E, A>(millis: number) =>
  (ma: TE.TaskEither<E, A>): TE.TaskEither<E, A> =>
  () =>
    new Promise(resolve => setTimeout(() => resolve(ma()), millis))

/**
 * Retries a TaskEither action on transient failures with exponential back-off
 */
export function retryWithBackoff<E, A>(
  action: (attempt: number) => TE.TaskEither<E, A>,
  isTransient: (error: E) => boolean,
  config: RetryConfig
): TE.TaskEither<E, A> {
  const run = (attempt: number): TE.TaskEither<E, A> => {
    return pipe(
      action(attempt),
      TE.orElse(error => {
        if (!isTransient(error) || attempt >= config.maxAttempts) {
          return TE.left(error)
        }

        const delay = Math.min(config.initialDelayMs * Math.pow(config.backoffFactor, attempt - 1), config.maxDelayMs)

        return pipe(
          TE.right<E, null>(null),
          delayTaskEither(delay),
          TE.chain(() => run(attempt + 1))
        )
      })
    )
  }

  return run(1)
}
