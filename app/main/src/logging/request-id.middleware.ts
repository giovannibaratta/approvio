import {BadRequestException, Injectable, NestMiddleware} from "@nestjs/common"
import {NextFunction, Request, Response} from "express"
import * as crypto from "crypto"
import {RequestContext} from "./request-context"

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  /**
   * Middleware to handle the `traceparent` header according to W3C Trace Context standard.
   *
   * It checks for an existing `traceparent` header. If present and valid, it uses it.
   * If missing or invalid, it generates a new valid `traceparent` header.
   * The format is `version-traceId-parentId-traceFlags` (e.g., `00-4bf92...-00f06...-01`).
   *
   * The `traceparent` is then stamped on the request and response headers, and stored
   * in the `RequestContext` for logging correlation.
   *
   * @param req - The Express request object.
   * @param res - The Express response object.
   * @param next - The next middleware function.
   */
  use(req: Request, res: Response, next: NextFunction): void {
    const traceparentHeader = req.headers["traceparent"]

    if (Array.isArray(traceparentHeader)) throw new BadRequestException("Multiple traceparent headers are not allowed")

    // Parse existing header or generate new trace components
    const incomingParts = this.parseTraceparent(traceparentHeader)

    // If we have a valid incoming traceId, preserve it. Otherwise generate a new one.
    const traceId = incomingParts ? incomingParts.traceId : crypto.randomBytes(16).toString("hex")

    // Always generate a new spanId for *this* unit of work (we are a child or a new root)
    const spanId = crypto.randomBytes(8).toString("hex")

    const version = "00"
    const flags = incomingParts ? incomingParts.flags : "01" // Preserve flags if present, else default to sampled

    const newTraceparent = `${version}-${traceId}-${spanId}-${flags}`

    // Update request header so downstream uses THIS span as parent
    req.headers["traceparent"] = newTraceparent
    // Set response header to identify THIS span
    res.setHeader("traceparent", newTraceparent)

    RequestContext.run(newTraceparent, () => {
      next()
    })
  }

  private parseTraceparent(header: string | undefined): {traceId: string; flags: string} | null {
    if (!header) return null
    const traceparentRegex = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
    const match = header.match(traceparentRegex)
    if (!match) return null

    const traceId = match[1]
    const flags = match[3]

    // Invalid traceparent
    if (!traceId || !flags) return null

    return {
      traceId,
      flags
    }
  }
}
