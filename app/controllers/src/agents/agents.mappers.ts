import {AgentRegistrationRequest, AgentRegistrationResponse} from "@approvio/api"
import {AgentWithPrivateKey, User} from "@domain"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger
} from "@nestjs/common"
import {RegisterAgentRequest, AgentRegistrationError} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"

export function agentRegistrationApiToServiceModel(data: {
  agentData: AgentRegistrationRequest
  requestor: User
}): Either<never, RegisterAgentRequest> {
  return right({
    agentName: data.agentData.agentName,
    requestor: data.requestor
  })
}

export function mapAgentToRegistrationResponse(agent: AgentWithPrivateKey): AgentRegistrationResponse {
  return {
    agentId: agent.id,
    agentName: agent.agentName,
    publicKey: Buffer.from(agent.publicKey).toString("base64"),
    privateKey: Buffer.from(agent.privateKey).toString("base64"),
    createdAt: agent.createdAt.toISOString()
  }
}

export function generateErrorResponseForRegisterAgent(error: AgentRegistrationError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "agent_name_empty":
    case "agent_name_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid agent name`))
    case "agent_name_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Agent with this name already exists`))
    case "agent_key_generation_failed":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Failed to generate encryption keys`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}
