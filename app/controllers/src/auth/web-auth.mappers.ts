import {AuthError, RefreshTokenCreateError} from "@services"
import {WebCallbackRequestValidationError} from "./web-auth.validators"

export type WebCallbackError = AuthError | RefreshTokenCreateError | WebCallbackRequestValidationError

export function mapWebCallbackErrorToCode(error: WebCallbackError): string {
  if (typeof error === "string") return error.toLowerCase()

  return "auth_failed"
}
