import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

// Use a type representing the subset of ioredis client we need to prevent version/module mismatches
interface RedisLockClient {
  set(key: string, value: string, mode: "PX", duration: number, flag: "NX"): Promise<unknown>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

export type RedisLockError =
  | {type: "lock_already_acquired"}
  | {type: "lock_acquisition_failed"; error: unknown}
  | {type: "lock_release_failed"; error?: unknown}
  | {type: "lock_execution_failed"; error: unknown}
  | {type: "operation_timeout"}

export class RedisLock {
  constructor(
    private readonly redis: RedisLockClient,
    private readonly key: string,
    private readonly ttlMs: number
  ) {}

  /**
   * Tries to acquire the lock. Returns the lock value (string) if acquired,
   * or a Left error if already locked or acquisition failed.
   */
  acquire(): TE.TaskEither<RedisLockError, string> {
    const value = `${Date.now()}-${Math.random()}`
    return pipe(
      TE.tryCatch(
        () => this.redis.set(this.key, value, "PX", this.ttlMs, "NX"),
        error => ({type: "lock_acquisition_failed" as const, error})
      ),
      TE.chain(acquired =>
        acquired === "OK" ? TE.right(value) : TE.left({type: "lock_already_acquired" as const} as RedisLockError)
      )
    )
  }

  /**
   * Releases the lock safely using a Lua script to ensure we only release our own lock value.
   */
  release(value: string): TE.TaskEither<RedisLockError, void> {
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `
    return pipe(
      TE.tryCatch(
        () => this.redis.eval(releaseScript, 1, this.key, value),
        error => ({type: "lock_release_failed" as const, error}) as RedisLockError
      ),
      TE.chain(result =>
        result === 1 ? TE.right(undefined) : TE.left({type: "lock_release_failed" as const} as RedisLockError)
      )
    )
  }

  /**
   * Executes a callback function with the lock held.
   * Ensures that:
   * 1. The lock is released on completion or error.
   * 2. The task is raced against a timeout to guarantee it terminates before the lock TTL expires.
   */
  runLocked<E, T>(timeoutMs: number, fn: () => TE.TaskEither<E, T>): TE.TaskEither<RedisLockError | E, T> {
    if (timeoutMs >= this.ttlMs) {
      return TE.left({
        type: "lock_acquisition_failed" as const,
        error: new Error(
          `Timeout (${timeoutMs}ms) must be strictly less than Lock TTL (${this.ttlMs}ms) to ensure safety.`
        )
      } as RedisLockError)
    }

    return pipe(
      this.acquire(),
      TE.chain(lockValue => {
        return async (): Promise<E.Either<RedisLockError | E, T>> => {
          let timeoutId: NodeJS.Timeout | undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject({type: "operation_timeout" as const})
            }, timeoutMs)
          })

          try {
            return await Promise.race([fn()(), timeoutPromise])
          } catch (err) {
            if (
              typeof err === "object" &&
              err !== null &&
              "type" in err &&
              typeof err.type === "string" &&
              err.type === "operation_timeout"
            )
              return E.left({type: "operation_timeout"})

            return E.left({type: "lock_execution_failed" as const, error: err})
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
            await this.release(lockValue)()
          }
        }
      })
    )
  }
}
