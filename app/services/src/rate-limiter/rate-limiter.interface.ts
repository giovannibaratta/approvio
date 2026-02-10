import {UnknownError} from "@services/error"
import * as TE from "fp-ts/TaskEither"
import {RateLimiterRes} from "rate-limiter-flexible"

export const RATE_LIMITER_PROVIDER_TOKEN = Symbol("RATE_LIMITER_PROVIDER_TOKEN")

export type ConsumePointsError = UnknownError

export interface RateLimiterProvider {
  consume(key: string, points: number): TE.TaskEither<ConsumePointsError, RateLimiterRes>
}
