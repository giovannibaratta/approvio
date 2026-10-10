import {ListUsers200Response, RoleOperationRequestValidationError, User as UserApi} from "@approvio/api"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PreconditionFailedException,
  UnprocessableEntityException
} from "@nestjs/common"
import {
  GetUserError,
  UserDetails,
  ListUsersRequest,
  PaginatedUsersList,
  UserListError,
  UserRoleAssignmentError,
  UserRoleRemovalError
} from "@services"
import {bindW, Do, Either, map, right, left} from "fp-ts/Either"
import {generateErrorPayload, isAuthorityError, mapAuthorityError} from "../error"
import {pipe} from "fp-ts/function"
import * as O from "fp-ts/Option"
import {Option} from "fp-ts/Option"
import {AuthenticatedEntity, OrganizationId} from "@domain"

export function mapUserToApi({user, groups}: UserDetails): UserApi {
  return {
    id: user.id,
    organizationId: user.organizationId,
    accountId: user.accountId,
    displayName: user.displayName,
    orgRole: user.orgRole,
    createdAt: user.createdAt.toISOString(),
    groups: groups.map(group => ({groupId: group.id, groupName: group.name})),
    roles: user.roles.map(role => ({roleName: role.name, scope: role.scope}))
  }
}

export function generateErrorResponseForGetUser(error: GetUserError, context: string): HttpException {
  if (isAuthorityError(error)) return mapAuthorityError(error)
  const payload = generateErrorPayload(error.toUpperCase(), `${context}: ${error}`)

  switch (error) {
    case "user_not_found":
      return new NotFoundException(payload)
    case "request_invalid_user_identifier":
      return new BadRequestException(payload)
    case "invalid_organization_id":
    case "tenant_context_required":
    case "user_invalid_organization_id":
    case "user_invalid_uuid":
    case "user_invalid_account_id":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_org_role_invalid":
    case "user_status_invalid":
    case "user_update_before_create":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_role_organization_mismatch":
    case "user_membership_roles_invalid":
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
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "role_scope_incompatible_with_template":
    case "role_entity_type_role_restriction":
    case "role_invalid_structure":
    case "unknown_error":
    case "conflicting_isolation_level":
    case "concurrency_error":
    case "group_not_found":
    case "group_invalid_organization_id":
    case "group_update_before_create":
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_description_too_long":
    case "group_entities_count_invalid":
      return new InternalServerErrorException(payload)
  }
}

export function mapUsersToApi(paginatedUsers: PaginatedUsersList): ListUsers200Response {
  const {users, page, limit, total} = paginatedUsers

  return {
    users: users.map(user => ({
      id: user.id,
      organizationId: user.organizationId,
      accountId: user.accountId,
      displayName: user.displayName,
      orgRole: user.orgRole
    })),
    pagination: {
      page,
      limit,
      total
    }
  }
}

export function generateErrorResponseForUserRoleAssignment(
  error: UserRoleAssignmentError | RoleOperationRequestValidationError | "invalid_etag",
  context: string
): HttpException {
  if (isAuthorityError(error)) return mapAuthorityError(error)
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_etag":
      return new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current entity tag")
      )
    case "quota_exceeded":
      throw new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: quota exceeded for assigning roles to user`)
      )
    case "malformed_object":
    case "missing_roles":
    case "invalid_roles":
    case "invalid_concurrency_control":
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
    case "quota_check_error":
    case "unknown_error":
    case "conflicting_isolation_level":
    case "audit_log_malformed_object":
    case "audit_log_invalid_audit_type":
    case "audit_log_invalid_entity_type":
    case "audit_log_invalid_actor_type":
    case "audit_log_invalid_payload":
    case "audit_log_missing_required_fields":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request for role assignment`))
    case "concurrent_modification_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: The user was affected by another request`)
      )

    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "invalid_organization_id":
    case "tenant_context_required":
    case "concurrency_error":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_invalid_occ":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_invalid_status":
    case "agent_update_before_create":
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
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_total_roles_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "agent_role_scope_incompatible_with_template":
    case "agent_role_entity_type_role_restriction":
    case "agent_role_invalid_structure":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_already_exists":
    case "resource_in_use":
    case "organization_owner_required":
    case "invalid_transition":
    case "invitation_invalid":
    case "agent_not_found":
    case "audit_log_organization_mismatch":
    case "audit_log_invalid_schema_version":
    case "user_role_organization_mismatch":
    case "user_update_before_create":
    case "user_invalid_organization_id":
    case "user_invalid_account_id":
    case "user_status_invalid":
    case "user_membership_roles_invalid":
      Logger.error(`${context}: Unhandled service failure: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForUserRoleRemoval(
  error: UserRoleRemovalError | RoleOperationRequestValidationError | "invalid_etag",
  context: string
): HttpException {
  if (isAuthorityError(error)) return mapAuthorityError(error)
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_etag":
      return new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current entity tag")
      )
    case "malformed_object":
    case "missing_roles":
    case "invalid_roles":
    case "invalid_concurrency_control":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request format`))
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "workflow_template_not_found":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Workflow template not found for role removal`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: Not authorized to remove roles`))
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
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid role removal format`))
    case "role_scope_incompatible_with_template":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: the specified scope is not supported by this role`)
      )
    case "role_entity_type_role_restriction":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: This role type cannot be removed from this entity`)
      )
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
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
    case "conflicting_isolation_level":
    case "audit_log_malformed_object":
    case "audit_log_invalid_audit_type":
    case "audit_log_invalid_entity_type":
    case "audit_log_invalid_actor_type":
    case "audit_log_invalid_payload":
    case "audit_log_missing_required_fields":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request for role removal`))
    case "concurrent_modification_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: The user was affected by another request`)
      )

    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "invalid_organization_id":
    case "tenant_context_required":
    case "concurrency_error":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_invalid_occ":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_invalid_status":
    case "agent_update_before_create":
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
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_total_roles_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "agent_role_scope_incompatible_with_template":
    case "agent_role_entity_type_role_restriction":
    case "agent_role_invalid_structure":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_already_exists":
    case "resource_in_use":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
    case "invitation_invalid":
    case "agent_not_found":
    case "audit_log_organization_mismatch":
    case "audit_log_invalid_schema_version":
    case "user_role_organization_mismatch":
    case "user_update_before_create":
    case "user_invalid_organization_id":
    case "user_invalid_account_id":
    case "user_status_invalid":
    case "user_membership_roles_invalid":
      Logger.error(`${context}: Unhandled service failure: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
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
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred while listing users`)
      )
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_invalid_organization_id":
    case "user_invalid_account_id":
    case "user_org_role_invalid":
    case "user_status_invalid":
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}

export function mapToServiceRequest(request: {
  search?: string
  page?: string
  limit?: string
  organizationId: OrganizationId
  requestor: AuthenticatedEntity
}): Either<"invalid_page_number" | "invalid_limit_number", ListUsersRequest> {
  const {search, page, limit, organizationId, requestor} = request

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
      limit: O.isSome(request.limit) ? request.limit.value : undefined,
      organizationId,
      requestor
    }))
  )
}
