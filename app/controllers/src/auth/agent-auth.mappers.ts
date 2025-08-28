import {AgentChallengeRequest, AgentChallengeResponse, AgentTokenResponse} from "@approvio/api"
import {GenerateChallengeRequest, AgentChallengeCreateError, AgentTokenError} from "@services"
import * as E from "fp-ts/Either"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException
} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"

type ChallengeRequestValidationError = "request_invalid_agent_name"

export interface JwtAssertionTokenRequest {
  grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  client_assertion: string
}

type JwtAssertionValidationError =
  | "request_invalid_grant_type"
  | "request_invalid_client_assertion_type"
  | "request_missing_client_assertion"
  | "request_invalid_client_assertion_format"

/**
 * Validates JWT assertion token request structure and required OAuth 2.0 parameters
 */
export const validateJwtAssertionTokenRequest = (
  request: unknown
): E.Either<JwtAssertionValidationError, JwtAssertionTokenRequest> => {
  if (!request || typeof request !== "object") return E.left("request_invalid_client_assertion_format")

  if (!("grant_type" in request) || request.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer")
    return E.left("request_invalid_grant_type")

  if (
    !("client_assertion_type" in request) ||
    request.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  )
    return E.left("request_invalid_client_assertion_type")

  if (!("client_assertion" in request) || !request.client_assertion || typeof request.client_assertion !== "string")
    return E.left("request_missing_client_assertion")

  return E.right({
    grant_type: request.grant_type,
    client_assertion_type: request.client_assertion_type,
    client_assertion: request.client_assertion
  })
}

/**
 * Maps API challenge request to service request
 */
export const mapAgentChallengeRequestToService = (
  request: AgentChallengeRequest
): E.Either<ChallengeRequestValidationError, GenerateChallengeRequest> => {
  if (!request.agentName || request.agentName.trim().length === 0) return E.left("request_invalid_agent_name")

  return E.right({
    agentName: request.agentName
  })
}

/**
 * Maps service challenge result to API response
 */
export const mapChallengeToApiResponse = (encryptedChallenge: string): AgentChallengeResponse => {
  return {
    challenge: encryptedChallenge
  }
}

/**
 * Maps service token result to API response
 */
export const mapTokenToApiResponse = (token: string): AgentTokenResponse => {
  return {
    token
  }
}

/**
 * Maps challenge creation errors to HTTP exceptions
 */
export const generateErrorResponseForChallengeRequest = (
  error: AgentChallengeCreateError | ChallengeRequestValidationError,
  context: string
): HttpException => {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "agent_challenge_storage_error":
    case "agent_challenge_nonce_generation_failed":
    case "agent_challenge_encryption_failed":
    case "unknown_error":
      Logger.error(`${context}: challenge creation error - ${error}`)
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "agent_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: agent not found`))
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_challenge_invalid_occ":
      Logger.error(`${context}: data inconsistency error - ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: data inconsistency error`)
      )
    case "request_invalid_agent_name":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid agent name`))
  }
}

/**
 * Maps token exchange errors to HTTP exceptions
 */
export const generateErrorResponseForAgentTokenExchange = (
  error: AgentTokenError | JwtAssertionValidationError,
  context: string
): HttpException => {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "request_invalid_grant_type":
    case "request_invalid_client_assertion_type":
    case "request_missing_client_assertion":
    case "request_invalid_client_assertion_format":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request format`))
    case "agent_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: agent not found`))
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
    case "agent_challenge_invalid_occ":
    case "agent_name_empty":
    case "agent_name_too_long":
      Logger.error(`${context}: data inconsistency error - ${error}`)
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid data inconsistency`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: unknown error`))
    case "agent_challenge_not_found":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_invalid_challenge_format":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: bad request`))
    case "agent_token_generation_failed":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: token generation error`))
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
      return new UnprocessableEntityException(generateErrorPayload(errorCode, `${context}: ${error}`))
    case "agent_challenge_update_failed":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: challenge error`))
    case "agent_challenge_concurrent_update":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update`))
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_invalid_claim_value":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid JWT assertion`))
    case "agent_challenge_jwt_expired":
    case "agent_challenge_jwt_not_yet_valid":
      return new UnprocessableEntityException(generateErrorPayload(errorCode, `${context}: JWT assertion time invalid`))
  }
}
