import {TokenRequest} from "@approvio/api"
import {hasOwnProperty} from "@utils"
import {Either, left, right} from "fp-ts/Either"

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
