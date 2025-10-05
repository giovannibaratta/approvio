import {AgentRegistrationRequest, AgentRegistrationResponse} from "@approvio/api"
import {AgentWithPrivateKey, AuthenticatedEntity} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException
} from "@nestjs/common"
import {RegisterAgentRequest, AgentRegistrationError, AgentRoleAssignmentError} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"
import {RoleAssignmentValidationError} from "../shared/mappers"

export function agentRegistrationApiToServiceModel(data: {
  agentData: AgentRegistrationRequest
  requestor: AuthenticatedEntity
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
    case "agent_role_invalid_uuid":
    case "agent_role_name_empty":
    case "agent_role_name_too_long":
    case "agent_role_name_invalid_characters":
    case "agent_role_permissions_empty":
    case "agent_role_permission_invalid":
    case "agent_role_invalid_scope":
    case "agent_role_resource_id_invalid":
    case "agent_role_resource_required_for_scope":
    case "agent_role_resource_not_allowed_for_scope":
    case "agent_role_invalid_structure":
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_total_roles_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "agent_role_scope_incompatible_with_template":
    case "agent_invalid_occ":
    case "agent_role_entity_type_role_restriction":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Requestor not authorized`))
  }
}

export function generateErrorResponseForAgentRoleAssignment(
  error: AgentRoleAssignmentError | RoleAssignmentValidationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "request_malformed":
    case "request_roles_missing":
    case "request_roles_not_array":
    case "request_roles_empty":
    case "request_role_name_missing":
    case "request_role_name_not_string":
    case "request_role_name_empty":
    case "request_scope_missing":
    case "request_scope_not_object":
    case "request_scope_type_missing":
    case "request_scope_type_invalid":
    case "request_scope_id_missing":
    case "request_scope_id_invalid_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request format`))
    case "agent_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Agent not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Not authorized to assign roles`))
    case "role_entity_type_role_restriction":
    case "agent_role_entity_type_role_restriction":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: this role can not be assigned to an Agent`)
      )
    case "role_assignments_empty":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Roles array cannot be empty`))
    case "role_unknown_role_name":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Unknown role name`))
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Maximum number of roles exceeded`))
    case "agent_role_total_roles_exceed_maximum":
      return new UnprocessableEntityException(
        generateErrorPayload(errorCode, `${context}: Maximum number of roles exceeded`)
      )
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_structure":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid role assignment format`))
    case "role_scope_incompatible_with_template":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: the specified scope is not supported by this role`)
      )
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_key_decode_error":
    case "agent_role_name_empty":
    case "agent_role_name_too_long":
    case "agent_role_name_invalid_characters":
    case "agent_role_permissions_empty":
    case "agent_role_permission_invalid":
    case "agent_role_invalid_scope":
    case "agent_role_resource_id_invalid":
    case "agent_role_resource_required_for_scope":
    case "agent_role_resource_not_allowed_for_scope":
    case "agent_role_invalid_uuid":
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "agent_role_scope_incompatible_with_template":
    case "agent_role_invalid_structure":
    case "agent_invalid_occ":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      Logger.error(`${context}: An expected error occurred: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid role assignment format`))
    case "concurrent_modification_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: The agent was affected by another request`)
      )
  }
}
