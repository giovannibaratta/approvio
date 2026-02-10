import {Inject, Injectable} from "@nestjs/common"
import {ConsumePointsError, RATE_LIMITER_PROVIDER_TOKEN, RateLimiterProvider} from "./rate-limiter.interface"
import * as TE from "fp-ts/TaskEither"
import {RateLimiterRes} from "rate-limiter-flexible"

@Injectable()
export class RateLimiterService {
  constructor(@Inject(RATE_LIMITER_PROVIDER_TOKEN) private readonly rateLimiter: RateLimiterProvider) {}

  consume(key: string, points: number): TE.TaskEither<ConsumePointsError, RateLimiterRes> {
    return this.rateLimiter.consume(key, points)
  }
}
