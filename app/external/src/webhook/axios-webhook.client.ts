import {Injectable, Logger} from "@nestjs/common"
import axios, {Method} from "axios"
import * as TE from "fp-ts/TaskEither"
import {HttpClient, HttpError, HttpResponse} from "@services/webhook/interfaces"
import {ResponseBodyStatus} from "@domain"

/**
 * Maximum body length to store in database (10KB).
 * Bodies exceeding this limit will be truncated to prevent database bloat
 * while still capturing useful debugging information.
 */
const MAX_BODY_LENGTH = 10000

/**
 * Maximum content length axios will download (1MB).
 * This prevents the server from consuming excessive memory when receiving
 * very large webhook responses. If a response exceeds this, axios will
 * reject it before downloading the entire body.
 */
const MAX_CONTENT_LENGTH = 1 * 1024 * 1024

@Injectable()
export class AxiosWebhookClient implements HttpClient {
  execute(
    url: string,
    method: string,
    headers?: Record<string, string>,
    payload?: unknown
  ): TE.TaskEither<HttpError, HttpResponse> {
    return TE.tryCatch(
      async () => {
        const response = await axios.request({
          url,
          method: method as Method,
          headers,
          data: payload,
          timeout: 10000,
          maxContentLength: MAX_CONTENT_LENGTH,
          maxBodyLength: MAX_CONTENT_LENGTH,
          // Resolve the promise for every status code, even for error codes.
          // This allows us to capture response bodies for 4xx/5xx errors for debugging.
          validateStatus: () => true
        })

        const extractionResult = this.extractResponseBody(response.data)

        return {
          status: response.status,
          body: extractionResult.body,
          bodyStatus: extractionResult.bodyStatus
        }
      },
      error => {
        if (axios.isAxiosError(error)) {
          Logger.error(`Webhook request failed: ${error.message} - ${error.code}`)
          if (error.code === "ECONNABORTED") {
            return "http_timeout" as const
          }

          // Network/connection failures - not related to response body since all HTTP
          // status codes are treated as valid responses via validateStatus above.
          return "http_request_failed" as const
        }
        Logger.error("Unknown webhook error", error)
        return "unknown_error" as const
      }
    )
  }

  /**
   * Extracts and normalizes the response body from axios response data.
   *
   * Returns Either:
   * - Left: ResponseBodyStatus when body cannot be extracted (MISSING, BINARY_DATA)
   * - Right: {body, bodyStatus} when body is successfully extracted (OK, TRUNCATED)
   *
   * Why JSON.stringify?
   * We store response bodies as TEXT in the database for debugging purposes.
   * Axios automatically parses JSON responses into objects, so we must re-serialize
   * them to strings for storage. This trade-off accepts:
   * 1. Performance cost of stringify for structured responses
   * 2. Loss of original formatting (whitespace, key ordering)
   */
  private extractResponseBody(data: unknown): {body?: string; bodyStatus: ResponseBodyStatus} {
    // No response body provided
    if (data === undefined || data === null) return {bodyStatus: ResponseBodyStatus.MISSING}
    // Binary data (Buffer or non-serializable types)
    if (Buffer.isBuffer(data)) return {bodyStatus: ResponseBodyStatus.BINARY_DATA}
    if (typeof data !== "string" && typeof data !== "object") return {bodyStatus: ResponseBodyStatus.PROCESSING_FAILED}

    // Serialize to string (objects get JSON stringified, strings pass through)
    let bodyString: string
    try {
      bodyString = typeof data === "string" ? data : JSON.stringify(data)
    } catch (error) {
      // JSON.stringify can fail for circular references or non-serializable objects
      Logger.warn("Failed to stringify response body - likely circular reference or non-serializable object", error)
      return {bodyStatus: ResponseBodyStatus.PROCESSING_FAILED}
    }

    // Truncate if exceeds database storage limit
    if (bodyString.length > MAX_BODY_LENGTH) {
      return {
        body: bodyString.substring(0, MAX_BODY_LENGTH),
        bodyStatus: ResponseBodyStatus.TRUNCATED
      }
    }

    return {body: bodyString, bodyStatus: ResponseBodyStatus.OK}
  }
}
