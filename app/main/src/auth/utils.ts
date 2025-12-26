import {hasOwnProperty} from "@utils"
import {JsonWebTokenError, TokenExpiredError} from "jsonwebtoken"

export function isTokenExpiredError(error: unknown): error is TokenExpiredError {
  if (!(error instanceof Error)) return false
  if (error.name !== "TokenExpiredError") return false
  if (!hasOwnProperty(error, "expiredAt") || !(error.expiredAt instanceof Date)) return false

  return true
}

export function isJsonWebTokenError(error: unknown): error is JsonWebTokenError {
  if (!(error instanceof Error)) return false
  if (error.name !== "JsonWebTokenError") return false

  return true
}
