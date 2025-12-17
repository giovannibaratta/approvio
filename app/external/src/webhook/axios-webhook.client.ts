import {Injectable, Logger} from "@nestjs/common"
import axios, {Method} from "axios"
import * as TE from "fp-ts/TaskEither"
import {HttpClient, HttpError} from "@services/webhook/interfaces"
import {HttpResponse, ResponseBodyStatus} from "@domain"

/**
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

const TIMEOUT = 10000

@Injectable()
export class AxiosWebhookClient implements HttpClient {
  /**
   * Executes an HTTP request
   *
   * This method makes HTTP requests to external endpoints with built-in safeguards
   * including timeouts, content length limits, and detailed error reporting. All HTTP status
   * codes are treated as valid responses to enable capture of error response bodies to be returned
   * to the caller.
   *
   * @param url - The target URL for the webhook request
   * @param method - HTTP method to use (e.g., 'GET', 'POST', 'PUT', 'DELETE')
   * @param headers - Optional HTTP headers to include with the request
   * @param payload - Optional request body/data to send with the request
   * @returns A TaskEither that resolves to either an HttpError on failure or an HttpResponse on success.
   *          The response includes the status code, processed body, and body status (OK, TRUNCATED, etc.)
   *
   * @example
   * ```typescript
   * const result = await client.execute(
   *   'https://api.example.com/webhook',
   *   'POST',
   *   { 'Content-Type': 'application/json' },
   *   { event: 'user.created', data: userData }
   * )
   * ```
   */
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
          timeout: TIMEOUT,
          maxContentLength: MAX_CONTENT_LENGTH,
          maxBodyLength: MAX_CONTENT_LENGTH,
          // Resolve the promise for every status code, even for error codes.
          // This allows us to capture response bodies for 4xx/5xx errors for debugging.
          validateStatus: () => true
        })

        const extractionResult = this.extractResponseBody(response.data)

        Logger.log(`Received status code ${response.status}, body status: ${extractionResult.bodyStatus}`)

        return {
          status: response.status,
          body: extractionResult.body,
          bodyStatus: extractionResult.bodyStatus
        }
      },
      error => {
        if (axios.isAxiosError(error)) {
          Logger.error(`Webhook request failed: ${error.message} - ${error.code}`)
          if (error.code === "ECONNABORTED") return "http_timeout" as const

          // Network/connection failures - not related to response body since all HTTP
          // status codes are treated as valid responses via validateStatus above.
          return "http_request_failed" as const
        }

        Logger.error("Unknown webhook error")
        Logger.error(error)
        return "unknown_error" as const
      }
    )
  }

  /**
   * Extracts and normalizes the response body from axios response data.
   *
   * Processes various response data types (strings, objects, buffers, etc.) and converts
   * them to a standardized string format suitable for database storage. Handles edge cases
   * like missing data, binary content, and oversized responses.
   *
   * @param data - The raw response data from axios (could be string, object, Buffer, etc.)
   * @returns An object containing the processed body string (if available) and a status
   *          indicating the processing result (OK, TRUNCATED, MISSING, BINARY_DATA, or PROCESSING_FAILED)
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

    // In the current context, we don't care much about the response body but more on the status code,
    // to keep the logic simple and don't over-engineer things, we support a limited set of data type
    // and we mask all other processing errors or unsupported data type.
    if (typeof data !== "string" && typeof data !== "object") {
      Logger.warn("Unsupported response body type", typeof data)
      return {bodyStatus: ResponseBodyStatus.PROCESSING_FAILED}
    }

    let bodyString: string
    try {
      bodyString = typeof data === "string" ? data : JSON.stringify(data)
    } catch (error) {
      // JSON.stringify can fail for circular references or non-serializable objects
      Logger.warn("Failed to stringify response body - likely circular reference or non-serializable object", error)
      return {bodyStatus: ResponseBodyStatus.PROCESSING_FAILED}
    }

    if (bodyString === "") return {bodyStatus: ResponseBodyStatus.MISSING}

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
