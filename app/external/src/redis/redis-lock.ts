import * as TE from "fp-ts/TaskEither"
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

class RedisLockTimeoutError extends Error {
  constructor() {
    super("Operation timed out")
    this.name = "RedisLockTimeoutError"
  }
}

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
      TE.tryCatch<RedisLockError, unknown>(
        () => this.redis.set(this.key, value, "PX", this.ttlMs, "NX"),
        error => ({type: "lock_acquisition_failed" as const, error})
      ),
      TE.chainW(acquired => (acquired === "OK" ? TE.right(value) : TE.left({type: "lock_already_acquired" as const})))
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
        error => ({type: "lock_release_failed" as const, error})
      ),
      TE.chain(result => (result === 1 ? TE.right(undefined) : TE.left({type: "lock_release_failed" as const})))
    )
  }

  /**
   * Executes a callback function with the lock held.
   * Ensures that:
   * 1. The lock is released on completion or error.
   * 2. The task is raced against a timeout to guarantee it terminates before the lock TTL expires.
   */
  runLocked<E, T>(timeoutMs: number, fn: () => TE.TaskEither<E, T>): TE.TaskEither<RedisLockError | E, T> {
    if (timeoutMs >= this.ttlMs)
      return TE.left({
        type: "lock_acquisition_failed" as const,
        error: new Error(
          `Timeout (${timeoutMs}ms) must be strictly less than Lock TTL (${this.ttlMs}ms) to ensure safety.`
        )
      })

    return TE.bracket(
      this.acquire(),
      _ =>
        pipe(
          TE.tryCatch(
            async () => {
              let timeoutId: NodeJS.Timeout | undefined
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new RedisLockTimeoutError()), timeoutMs)
              })

              try {
                return await Promise.race([fn()(), timeoutPromise])
              } finally {
                if (timeoutId) clearTimeout(timeoutId)
              }
            },
            (error): RedisLockError | E => {
              if (error instanceof RedisLockTimeoutError) return {type: "operation_timeout"}
              return {type: "lock_execution_failed", error}
            }
          ),
          TE.chainW(TE.fromEither)
        ),
      lockValue => this.release(lockValue)
    )
  }
}
