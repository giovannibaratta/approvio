import {TokenRequest, RefreshTokenRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"
import {Either, left, right} from "fp-ts/Either"
import {hasOwnProperty} from "@utils"

export type CliInitiateLoginRequestValidationError = "request_missing_redirect_uri" | "request_invalid_redirect_uri"

export type CliGenerateTokenRequestValidationError =
  | "request_empty_body"
  | "request_missing_code"
  | "request_invalid_code"
  | "request_missing_state"
  | "request_invalid_state"

export type CliRefreshTokenRequestValidationError = "request_missing_refresh_token" | "request_invalid_refresh_token"

export type CliPrivilegedTokenExchangeRequestValidationError =
  | "request_empty_body"
  | "request_missing_code"
  | "request_invalid_code"
  | "request_missing_state"
  | "request_invalid_state"
  | "request_invalid_resource_id"
  | "request_missing_operation"
  | "request_invalid_operation"

export function validateInitiateCliLoginRequest(
  body: unknown
): Either<CliInitiateLoginRequestValidationError, {redirectUri: string}> {
  if (!body || !hasOwnProperty(body, "redirectUri")) return left("request_missing_redirect_uri")
  if (typeof body.redirectUri !== "string" || !body.redirectUri) return left("request_invalid_redirect_uri")

  return right({redirectUri: body.redirectUri})
}

export function validateGenerateCliTokenRequest(
  body: unknown
): Either<CliGenerateTokenRequestValidationError, TokenRequest> {
  if (!body) return left("request_empty_body")

  if (!hasOwnProperty(body, "code")) return left("request_missing_code")
  if (typeof body.code !== "string" || !body.code) return left("request_invalid_code")

  if (!hasOwnProperty(body, "state")) return left("request_missing_state")
  if (typeof body.state !== "string" || !body.state) return left("request_invalid_state")

  return right({code: body.code, state: body.state})
}

export function validateRefreshCliTokenRequest(
  body: unknown
): Either<CliRefreshTokenRequestValidationError, RefreshTokenRequest> {
  if (!body || !hasOwnProperty(body, "refreshToken")) return left("request_missing_refresh_token")

  const refreshToken = body.refreshToken
  if (typeof refreshToken !== "string" || !refreshToken) return left("request_invalid_refresh_token")

  return right({refreshToken})
}

export function validateExchangeCliPrivilegeTokenRequest(
  body: unknown
): Either<CliPrivilegedTokenExchangeRequestValidationError, PrivilegedTokenExchangeRequest> {
  if (!body) return left("request_empty_body")

  if (!hasOwnProperty(body, "code")) return left("request_missing_code")
  if (typeof body.code !== "string" || !body.code) return left("request_invalid_code")

  if (!hasOwnProperty(body, "state")) return left("request_missing_state")
  if (typeof body.state !== "string" || !body.state) return left("request_invalid_state")

  let resourceId: string | undefined = undefined

  if (hasOwnProperty(body, "resourceId")) {
    if (typeof body.resourceId !== "string" || !body.resourceId) return left("request_invalid_resource_id")
    resourceId = body.resourceId
  }

  if (!hasOwnProperty(body, "operation")) return left("request_missing_operation")
  if (typeof body.operation !== "string") return left("request_invalid_operation")

  return right({
    code: body.code,
    state: body.state,
    resourceId: resourceId,
    operation: body.operation
  })
}
