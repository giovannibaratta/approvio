import {TokenRequest, RefreshTokenRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"
import {Either, left, map, right} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {hasOwnProperty} from "@utils"

export type CliInitiateLoginRequestValidationError =
  "request_missing_redirect_uri" | "request_invalid_redirect_uri" | "request_invalid_provider"

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

function extractProvider(body: object): Either<"request_invalid_provider", string | undefined> {
  if (!hasOwnProperty(body, "provider") || body.provider === undefined) return right(undefined)

  if (typeof body.provider !== "string" || !body.provider) return left("request_invalid_provider")

  return right(body.provider)
}

export function validateInitiateCliLoginRequest(
  body: unknown
): Either<CliInitiateLoginRequestValidationError, {redirectUri: string; provider?: string}> {
  if (!body || typeof body !== "object") return left("request_missing_redirect_uri")
  if (!hasOwnProperty(body, "redirectUri")) return left("request_missing_redirect_uri")
  if (typeof body.redirectUri !== "string" || !body.redirectUri) return left("request_invalid_redirect_uri")

  const redirectUri = body.redirectUri

  return pipe(
    extractProvider(body),
    map(provider => ({
      redirectUri,
      ...(provider && {provider})
    }))
  )
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
