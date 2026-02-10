import {CanActivate, ExecutionContext, Injectable, Logger, HttpException, HttpStatus} from "@nestjs/common"
import {RateLimiterRes} from "@external/rate-limiter"
import {AuthenticatedEntity} from "@domain"
import {RateLimiterService} from "@services/rate-limiter"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {ConfigProvider} from "@external/config"
import {generateErrorPayload} from "@controllers/error"

@Injectable()
export class RateLimiterGuard implements CanActivate {
  private rateLimitMaximumRequestsPerWindows: number
  private rateLimitWindowSize: number

  constructor(
    private readonly rateLimiterService: RateLimiterService,
    readonly configProvider: ConfigProvider
  ) {
    this.rateLimitMaximumRequestsPerWindows = configProvider.rateLimitConfig.points
    this.rateLimitWindowSize = configProvider.rateLimitConfig.durationInSeconds
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const user = request.user as AuthenticatedEntity | undefined

    if (!user) {
      Logger.debug("Rate limiter: user not authenticated, allowing request")
      // Rate limit only authenticated users for now
      return true
    }

    const entityFullId =
      user.entityType === "user" ? `${user.entityType}:${user.user.id}` : `${user.entityType}:${user.agent.id}`

    const result = await pipe(
      this.rateLimiterService.consume(entityFullId, 1),
      TE.match(
        error => {
          // Fail-open strategy:
          // If the rate limiter (e.g., Redis) fails, we log the error but allow the request to proceed.
          // This ensures that infrastructure issues do not block legitimate traffic.
          Logger.error("Rate limiter failed, allowing request as best-effort", error)
          return true
        },
        rateLimiterRes => {
          this.setHeaders(context, rateLimiterRes)

          if (rateLimiterRes.consumedPoints > this.rateLimitMaximumRequestsPerWindows) {
            throw new HttpException(
              generateErrorPayload("TOO_MANY_REQUESTS", "Rate limit exceeded"),
              HttpStatus.TOO_MANY_REQUESTS
            )
          }

          return true
        }
      )
    )()

    return result
  }

  private setHeaders(context: ExecutionContext, rateLimiterRes: RateLimiterRes) {
    const response = context.switchToHttp().getResponse()

    // IETF standard
    // RateLimit: limit=<number>, remaining=<number>, reset=<seconds>
    // limit: The maximum number of requests allowed within the current window.
    // remaining: How many requests the client can still make before being blocked.
    // reset: The time remaining until the quota is replenished, expressed in seconds (delta-seconds).
    // RateLimit-Policy: <limit>;w=<time_window_in_seconds>

    // HTTP Standard
    // Retry-After: date | delta-seconds

    const now = Date.now()
    const reset = Math.ceil(rateLimiterRes.msBeforeNext / 1000)
    const retryAfter = new Date(now + rateLimiterRes.msBeforeNext).toUTCString()

    response.header(
      "RateLimit",
      `limit=${this.rateLimitMaximumRequestsPerWindows}, remaining=${rateLimiterRes.remainingPoints}, reset=${reset}`
    )
    response.header("RateLimit-Policy", `${this.rateLimitMaximumRequestsPerWindows};w=${this.rateLimitWindowSize}`)
    response.header("Retry-After", retryAfter)
  }
}
