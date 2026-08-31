import * as TE from "fp-ts/TaskEither"

export interface ReservationResult {
  readonly allowed: boolean
  readonly consumed: number
  readonly reserved: number
}

export type RedisError =
  {readonly type: "redis_error"; readonly error: unknown} | {readonly type: "invalid_response"; readonly error: unknown}

export interface QuotaAdmissionClient {
  reserve(
    key: string,
    limit: number,
    estimate: number,
    ttlSeconds?: number
  ): TE.TaskEither<RedisError, ReservationResult>

  settle(key: string, estimate: number, actual: number): TE.TaskEither<RedisError, number>

  release(key: string, estimate: number): TE.TaskEither<RedisError, void>

  getUsage(key: string): TE.TaskEither<RedisError, {consumed: number; reserved: number}>
}

export const QUOTA_ADMISSION_CLIENT_TOKEN = Symbol("QUOTA_ADMISSION_CLIENT_TOKEN")
