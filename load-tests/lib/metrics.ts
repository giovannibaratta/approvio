import { Counter } from "k6/metrics"
import { check } from "k6"
import { Response } from "k6/http"

// Predefined counters for transport-level errors and common Approvio errors
export const error_CONNECTION_RESET = new Counter("error_CONNECTION_RESET")
export const error_TIMEOUT = new Counter("error_TIMEOUT")
export const error_k6_PARSING_ERROR = new Counter("error_k6_PARSING_ERROR")
export const error_WORKFLOW_ALREADY_EXISTS = new Counter("error_WORKFLOW_ALREADY_EXISTS")
export const error_SERVICE_UNAVAILABLE = new Counter("error_SERVICE_UNAVAILABLE")
export const error_CONCURRENCY_CONFLICT = new Counter("error_CONCURRENCY_CONFLICT")
export const error_RATE_LIMIT = new Counter("error_RATE_LIMIT")
export const error_OTHER = new Counter("error_OTHER")

/**
 * Parses a response and tracks transport and application-level errors.
 * Increments the appropriate custom metrics counters and registers a k6 check.
 */
export function trackResponse(res: Response, endpoint: string) {
  let errorCode: string | null = null


  // 1. Handle transport-level socket/network errors
  if (res.error) {
    const errMsg = res.error.toLowerCase()
    if (errMsg.includes("connection reset") || errMsg.includes("reset by peer")) {
      errorCode = "CONNECTION_RESET"
      error_CONNECTION_RESET.add(1)
    } else if (errMsg.includes("timeout")) {
      errorCode = "TIMEOUT"
      error_TIMEOUT.add(1)
    } else {
      errorCode = "TRANSPORT_ERROR"
      error_OTHER.add(1)
    }
  }

  // 2. Handle HTTP-level errors (status >= 400)
  else if (res.status >= 400) {
    if (res.status === 409) {
      errorCode = "CONCURRENCY_CONFLICT"
      error_CONCURRENCY_CONFLICT.add(1)
    } else if (res.status === 429) {
      errorCode = "RATE_LIMIT"
      error_RATE_LIMIT.add(1)
    } else {
      let bodyObj: any = null
      try {
        bodyObj = typeof res.body === "string" ? JSON.parse(res.body) : res.body
      } catch (e) {
        errorCode = "k6_PARSING_ERROR"
        error_k6_PARSING_ERROR.add(1)
      }

      if (!errorCode) {
        if (bodyObj && typeof bodyObj === "object" && typeof bodyObj.code === "string") {
          errorCode = bodyObj.code
          if (errorCode === "WORKFLOW_ALREADY_EXISTS") {
            error_WORKFLOW_ALREADY_EXISTS.add(1)
          } else if (errorCode === "SERVICE_UNAVAILABLE") {
            error_SERVICE_UNAVAILABLE.add(1)
          } else {
            error_OTHER.add(1)
          }
        } else {
          errorCode = "k6_PARSING_ERROR"
          error_k6_PARSING_ERROR.add(1)
        }
      }
    }
  }

  // 3. Register a failing check if an error occurred.
  // In k6, a check validates a boolean condition. By calling check(res, { 'msg': () => false })
  // when an error occurs, we deliberately record a failed check. The check name is dynamically generated
  // using the endpoint and the specific error code, which allows k6 reporters (such as benc-uk/k6-reporter
  // which outputs report.html) to display a detailed list of all unique errors encountered per endpoint.
  if (errorCode) {
    check(res, {
      [`[${endpoint}] Error Code: ${errorCode}`]: () => false
    })
  }
}
