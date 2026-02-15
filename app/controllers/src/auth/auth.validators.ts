import {RefreshTokenRequest, TokenRequest} from "@approvio/api"
import {StepUpTokenRequest} from "@services"
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

export type StepUpTokenRequestValidationError =
  | "request_empty_body"
  | "request_missing_idp_token"
  | "request_invalid_idp_token"
  | "request_missing_resource_id"
  | "request_invalid_resource_id"
  | "request_missing_operation"
  | "request_invalid_operation"

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

export function validateStepUpTokenRequest(body: unknown): Either<StepUpTokenRequestValidationError, StepUpTokenRequest> {
  if (!body) return left("request_empty_body")

  if (!hasOwnProperty(body, "idpToken")) return left("request_missing_idp_token")
  if (typeof body.idpToken !== "string") return left("request_invalid_idp_token")
  if (!body.idpToken) return left("request_invalid_idp_token")

  if (!hasOwnProperty(body, "resourceId")) return left("request_missing_resource_id")
  if (typeof body.resourceId !== "string") return left("request_invalid_resource_id")
  if (!body.resourceId) return left("request_invalid_resource_id")

  if (!hasOwnProperty(body, "operation")) return left("request_missing_operation")
  if (typeof body.operation !== "string") return left("request_invalid_operation")
  if (!body.operation) return left("request_invalid_operation")

  return right({
    idpToken: body.idpToken,
    resourceId: body.resourceId,
    operation: body.operation
  })
}
