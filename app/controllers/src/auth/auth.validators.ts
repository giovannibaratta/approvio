import {RefreshTokenRequest, TokenRequest} from "@approvio/api"
import {hasOwnProperty} from "@utils"
import {Either, left, right} from "fp-ts/Either"

export type RefreshTokenRequestValidationError =
  | "request_empty_body"
  | "request_missing_refresh_token"
  | "request_invalid_refresh_token"

export type RefreshAgentTokenRequestValidationError =
  | "request_empty_body"
  | "request_missing_refresh_token"
  | "request_invalid_refresh_token"
  | "request_invalid_dpop_jkt"

export type GenerateTokenRequestValidationError =
  | "request_empty_body"
  | "request_missing_code"
  | "request_invalid_code"
  | "request_missing_state"
  | "request_invalid_state"

export function validateGenerateTokenRequest(body: unknown): Either<GenerateTokenRequestValidationError, TokenRequest> {
  if (!body) return left("request_empty_body")
  if (!hasOwnProperty(body, "code")) return left("request_missing_code")
  if (typeof body.code !== "string") return left("request_invalid_code")
  if (!body.code) return left("request_invalid_code")

  if (!hasOwnProperty(body, "state")) return left("request_missing_state")
  if (typeof body.state !== "string") return left("request_invalid_state")
  if (!body.state) return left("request_invalid_state")

  return right({code: body.code, state: body.state})
}

export function validateRefreshTokenRequest(
  body: unknown
): Either<RefreshTokenRequestValidationError, RefreshTokenRequest> {
  if (!body) return left("request_empty_body")
  if (!hasOwnProperty(body, "refreshToken")) return left("request_missing_refresh_token")
  if (typeof body.refreshToken !== "string") return left("request_invalid_refresh_token")
  if (!body.refreshToken) return left("request_invalid_refresh_token")

  return right({refreshToken: body.refreshToken})
}

export function validateRefreshAgentTokenRequest(
  body: unknown,
  dpopJkt: string
): Either<RefreshAgentTokenRequestValidationError, RefreshTokenRequest & {dpopJkt: string}> {
  if (!body) return left("request_empty_body")
  if (!hasOwnProperty(body, "refreshToken")) return left("request_missing_refresh_token")
  if (typeof body.refreshToken !== "string") return left("request_invalid_refresh_token")
  if (!body.refreshToken) return left("request_invalid_refresh_token")

  if (typeof dpopJkt !== "string") return left("request_invalid_dpop_jkt")

  return right({refreshToken: body.refreshToken, dpopJkt})
}
