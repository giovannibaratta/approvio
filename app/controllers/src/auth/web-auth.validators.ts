import {OidcCallbackRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"
import {hasOwnProperty} from "@utils"
import {Either, left, right} from "fp-ts/Either"

export type WebCallbackRequestValidationError =
  | "request_missing_code"
  | "request_invalid_code"
  | "request_missing_state"
  | "request_invalid_state"

export type WebRefreshTokenRequestValidationError = "request_missing_refresh_token" | "request_invalid_refresh_token"

export type WebPrivilegedTokenExchangeRequestValidationError =
  | "request_empty_body"
  | "request_missing_code"
  | "request_invalid_code"
  | "request_missing_state"
  | "request_invalid_state"
  | "request_invalid_resource_id"
  | "request_missing_operation"
  | "request_invalid_operation"

export function validateWebCallbackRequest(
  query: unknown
): Either<WebCallbackRequestValidationError, OidcCallbackRequest> {
  if (!query) return left("request_missing_code")

  if (!hasOwnProperty(query, "code")) return left("request_missing_code")
  if (typeof query.code !== "string" || !query.code) return left("request_invalid_code")

  if (!hasOwnProperty(query, "state")) return left("request_missing_state")
  if (typeof query.state !== "string" || !query.state) return left("request_invalid_state")

  return right({code: query.code, state: query.state})
}

export function validateWebRefreshTokenRequest(
  cookies: unknown
): Either<WebRefreshTokenRequestValidationError, string> {
  if (!cookies || !hasOwnProperty(cookies, "refresh_token")) return left("request_missing_refresh_token")

  const refreshToken = cookies.refresh_token
  if (typeof refreshToken !== "string" || !refreshToken) return left("request_invalid_refresh_token")

  return right(refreshToken)
}

export function validateExchangeWebPrivilegeTokenRequest(
  body: unknown
): Either<WebPrivilegedTokenExchangeRequestValidationError, PrivilegedTokenExchangeRequest> {
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
