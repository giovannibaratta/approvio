import {ListUsers200Response, User as UserApi, UserCreate} from "@approvio/api"
import {AuthenticatedEntity, User as UserDomain} from "@domain"
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
import {
  AuthorizationError,
  CreateUserRequest,
  ListUsersRequest,
  PaginatedUsersList,
  UserCreateError,
  UserGetError,
  UserListError,
  UserRoleAssignmentError
} from "@services"
import {bindW, Do, Either, map, right, left} from "fp-ts/Either"
import {generateErrorPayload} from "../error"
import {pipe} from "fp-ts/lib/function"
import * as O from "fp-ts/Option"
import {Option} from "fp-ts/Option"
import {RoleAssignmentValidationError} from "../shared/mappers"

export function createUserApiToServiceModel(data: {
  userData: UserCreate
  requestor: AuthenticatedEntity
}): Either<never, CreateUserRequest> {
  return right({
    userData: data.userData,
    requestor: data.requestor
  })
}

export function mapUserToApi(user: UserDomain): UserApi {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
    orgRole: user.orgRole
  }
}

export function generateErrorResponseForCreateUser(
  error: UserCreateError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid user data`))
    case "user_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: User with this email already exists`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "user_invalid_uuid":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "user_org_role_invalid":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_uuid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "role_invalid_structure":
    case "role_entity_type_role_restriction":
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "role_scope_incompatible_with_template":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

export function generateErrorResponseForGetUser(error: UserGetError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid identifier`))
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_uuid":
    case "role_invalid_structure":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "unknown_error":
    case "role_entity_type_role_restriction":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "role_scope_incompatible_with_template":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

export function mapUsersToApi(paginatedUsers: PaginatedUsersList): ListUsers200Response {
  const {users, page, limit, total} = paginatedUsers

  return {
    users: users.map(user => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email
    })),
    pagination: {
      page,
      limit,
      total
    }
  }
}

export function generateErrorResponseForUserRoleAssignment(
  error: UserRoleAssignmentError | RoleAssignmentValidationError,
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
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "workflow_template_not_found":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Workflow template not found for role assignment`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Not authorized to assign roles`))
    case "role_assignments_empty":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Roles array cannot be empty`))
    case "role_unknown_role_name":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Unknown role name`))
    case "role_assignments_exceed_maximum":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Request contains too many roles`))
    case "role_total_roles_exceed_maximum":
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
    case "role_entity_type_role_restriction":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: This role type cannot be assigned to this entity`)
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
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request for role assignment`))
    case "concurrent_modification_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: The user was affected by another request`)
      )
  }
}

export function generateErrorResponseForListUsers(error: UserListError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_page_number":
    case "invalid_limit_number":
    case "search_too_long":
    case "search_term_invalid_characters":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid search conditions"))
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred while listing users`)
      )
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}

export function mapToServiceRequest(request: {
  search?: string
  page?: string
  limit?: string
}): Either<"invalid_page_number" | "invalid_limit_number", ListUsersRequest> {
  const {search, page, limit} = request

  const validateInteger = <LValue>(value: string | undefined, lValue: LValue): Either<LValue, Option<number>> => {
    if (!value) return right(O.none)

    try {
      return right(O.some(parseInt(value)))
    } catch {
      return left(lValue)
    }
  }

  return pipe(
    Do,
    bindW("search", () => right(search)),
    bindW("page", () => validateInteger(page, "invalid_page_number" as const)),
    bindW("limit", () => validateInteger(limit, "invalid_limit_number" as const)),
    map(request => ({
      search: request.search,
      page: O.isSome(request.page) ? request.page.value : undefined,
      limit: O.isSome(request.limit) ? request.limit.value : undefined
    }))
  )
}
