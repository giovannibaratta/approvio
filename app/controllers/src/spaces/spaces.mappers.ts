import {Space as SpaceApi, SpaceCreate, ListSpaces200Response} from "@approvio/api"
import {AuthenticatedEntity, Space, SpaceValidationError} from "@domain"
import {
  CreateSpaceError,
  CreateSpaceRequest,
  DeleteSpaceError,
  GetSpaceError,
  ListSpacesError,
  ListSpacesResult
} from "@services"
import {Versioned} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  HttpException,
  Logger
} from "@nestjs/common"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "@controllers/error"

export function createSpaceApiToServiceModel(data: {
  request: SpaceCreate
  requestor: AuthenticatedEntity
}): Either<SpaceValidationError, CreateSpaceRequest> {
  const spaceData = {
    name: data.request.name,
    description: data.request.description
  }

  return right({
    spaceData,
    requestor: data.requestor
  })
}

export function mapSpaceToApi(space: Versioned<Space>): SpaceApi {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString()
  }
}

export function mapListSpacesResultToApi(result: ListSpacesResult): ListSpaces200Response {
  return {
    data: result.spaces.map(mapSpaceToApi),
    pagination: {
      total: result.total,
      page: result.page,
      limit: result.limit
    }
  }
}

export function generateErrorResponseForCreateSpace(error: CreateSpaceError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "space_name_empty":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: space name cannot be empty`))
    case "space_name_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: space name is too long`))
    case "space_name_invalid_characters":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: space name contains invalid characters`)
      )
    case "space_description_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: space description is too long`))
    case "space_invalid_uuid":
    case "space_update_before_create":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "space_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: space already exists`))
    case "concurrency_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: concurrent modification detected`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: an unexpected error occurred`)
      )
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "role_invalid_uuid":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_structure":
    case "user_not_found":
    case "user_not_found_in_db":
    case "request_invalid_user_identifier":
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "role_scope_incompatible_with_template":
    case "role_entity_type_role_restriction":
      Logger.error(`Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Internal data inconsistency"))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Requestor not authorized`))
  }
}

export function generateErrorResponseForGetSpace(error: GetSpaceError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "space_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: space not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: you are not authorized to perform this action`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: an unexpected error occurred`)
      )
    case "space_name_empty":
    case "space_name_too_long":
    case "space_name_invalid_characters":
    case "space_description_too_long":
    case "space_invalid_uuid":
    case "space_update_before_create":
      Logger.error(`Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}

export function generateErrorResponseForListSpaces(error: ListSpacesError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_page":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid page parameter`))
    case "invalid_limit":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid limit parameter`))
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: an unexpected error occurred`)
      )
    case "space_name_empty":
    case "space_name_too_long":
    case "space_name_invalid_characters":
    case "space_description_too_long":
    case "space_invalid_uuid":
    case "space_update_before_create":
      Logger.error(`Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Requestor not authorized`))
  }
}

export function generateErrorResponseForDeleteSpace(error: DeleteSpaceError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "space_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: space not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: you are not authorized to perform this action`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: an unexpected error occurred`)
      )
  }
}
