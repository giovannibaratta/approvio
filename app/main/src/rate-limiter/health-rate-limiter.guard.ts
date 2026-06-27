import {CanActivate, ExecutionContext, Injectable, Logger, HttpException, HttpStatus} from "@nestjs/common"
import {Request, Response} from "express"
import {RateLimiterMemory, RateLimiterRes} from "rate-limiter-flexible"
import {generateErrorPayload} from "@controllers/error"

/**
 * Guard that applies rate limiting to the health check endpoint.
 * Prevents denial-of-service (DDoS) and resource exhaustion by restricting
 * requests on a per-IP basis.
 */
@Injectable()
export class HealthRateLimiterGuard implements CanActivate {
  public readonly rateLimiter: RateLimiterMemory

  /** The maximum number of requests allowed within the duration window. */
  private readonly points = 1

  /** The rate limiting window duration in seconds. */
  private readonly duration = 1

  constructor() {
    this.rateLimiter = new RateLimiterMemory({
      points: this.points,
      duration: this.duration
    })
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const response = context.switchToHttp().getResponse<Response>()
    const ip = request.ip

    // Standard NestJS/Express request.ip is used. If deployed behind a Load
    // Balancer or WAF, trust proxy must be configured on the Express app instance
    // to correctly parse X-Forwarded-For header.
    // Fallback to "unknown" if ip is undefined.
    const key = ip || "unknown"

    // Note: RateLimiterMemory automatically expires and deletes client keys from memory
    // after the duration window has elapsed (i.e. points are fully restored). This prevents
    // unbounded memory accumulation and potential memory-exhaustion attack vectors.

    try {
      const rateLimiterRes = await this.rateLimiter.consume(key, 1)

      const now = Date.now()
      const reset = Math.ceil(rateLimiterRes.msBeforeNext / 1000)
      const retryAfter = new Date(now + rateLimiterRes.msBeforeNext).toUTCString()

      response.header("RateLimit", `limit=${this.points}, remaining=${rateLimiterRes.remainingPoints}, reset=${reset}`)
      response.header("RateLimit-Policy", `${this.points};w=${this.duration}`)
      response.header("Retry-After", retryAfter)

      return true
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        const rateLimiterRes = rejection

        const now = Date.now()
        const reset = Math.ceil(rateLimiterRes.msBeforeNext / 1000)
        const retryAfter = new Date(now + rateLimiterRes.msBeforeNext).toUTCString()

        response.header(
          "RateLimit",
          `limit=${this.points}, remaining=${rateLimiterRes.remainingPoints}, reset=${reset}`
        )
        response.header("RateLimit-Policy", `${this.points};w=${this.duration}`)
        response.header("Retry-After", retryAfter)

        throw new HttpException(
          generateErrorPayload("TOO_MANY_REQUESTS", "Rate limit exceeded"),
          HttpStatus.TOO_MANY_REQUESTS
        )
      }

      Logger.error(
        "Unexpected error in health check rate limiter, allowing request as best-effort",
        rejection instanceof Error ? rejection.stack : String(rejection)
      )
      // If it fails for an unexpected reason, we let it pass
      return true
    }
  }
}
