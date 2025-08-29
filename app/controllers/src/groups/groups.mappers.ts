import {Group as GroupApi, GroupCreate, ListGroupEntities200Response, ListGroups200Response} from "@approvio/api"
import {EntityType} from "@controllers/shared/types"
import {
  DESCRIPTION_MAX_LENGTH,
  Group as GroupDomain,
  GroupWithEntitiesCount,
  Membership,
  NAME_MAX_LENGTH
} from "@domain"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
  Logger
} from "@nestjs/common"
import {
  CreateGroupError,
  GetGroupError,
  GetGroupMembershipResult,
  ListGroupsRepoError,
  ListGroupsResult,
  AuthorizationError,
  CreateGroupRequest,
  GroupMembershipService,
  AuthenticatedEntity
} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"
import {ExtractLeftFromMethod} from "@utils"

export type CreateGroupRequestValidationError = never

export function createGroupApiToServiceModel(data: {
  request: GroupCreate
  requestor: AuthenticatedEntity
}): Either<CreateGroupRequestValidationError, CreateGroupRequest> {
  return right({
    groupData: {description: data.request.description ?? null, name: data.request.name},
    requestor: data.requestor
  })
}

export function mapGroupWithEntitiesCountToApi(data: GroupWithEntitiesCount): GroupApi {
  const group = mapGroupToApi(data)

  return {
    ...group,
    entitiesCount: data.entitiesCount
  }
}

export function mapGroupWithMembershipToApi(data: GetGroupMembershipResult): GroupApi {
  const group = mapGroupToApi(data.group)

  return {
    ...group,
    entitiesCount: data.memberships.length
  }
}

function mapGroupToApi(group: GroupDomain): Omit<GroupApi, "entitiesCount"> {
  return {
    id: group.id,
    name: group.name,
    description: group.description ?? undefined,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString()
  }
}

export function mapListGroupsResultToApi(result: ListGroupsResult): ListGroups200Response {
  return {
    groups: result.groups.map(mapGroupWithEntitiesCountToApi),
    pagination: {
      total: result.total,
      page: result.page,
      limit: result.limit
    }
  }
}

export function mapListGroupMembersResultToApi(
  page: number,
  limit: number,
  result: GetGroupMembershipResult
): ListGroupEntities200Response {
  // Fake paginated result for now
  const page0Index = page - 1
  const pageEntities = result.memberships.slice(page0Index * limit, (page0Index + 1) * limit)

  return {
    entities: pageEntities.map(mapMembershipToListEntitiesItemApi),
    pagination: {
      total: result.memberships.length,
      page: page,
      limit: limit
    }
  }
}

export function generateErrorResponseForCreateGroup(error: CreateGroupError, context: string): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "group_description_too_long":
      return new BadRequestException(
        generateErrorPayload(
          errorCode,
          `${context}: group description must be less than ${DESCRIPTION_MAX_LENGTH} characters`
        )
      )
    case "group_name_too_long":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: group name must be less than ${NAME_MAX_LENGTH} characters`)
      )
    case "group_name_empty":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: group name can not be empty`))
    case "group_name_invalid_characters":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: group name contains invalid characters`)
      )
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "group_entities_count_invalid":
    case "group_update_before_create":
    case "user_org_role_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "group_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: group already exists`))
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Creator user not found`))
    case "user_invalid_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid UUID provided`))
    case "membership_entity_already_in_group":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Entity already in group`))
    case "unknown_error":
    case "membership_duplicated_membership":
    case "group_not_found":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "membership_inconsistent_dates":
    case "membership_invalid_entity_uuid":
    case "concurrent_modification_error":
    case "membership_group_not_found":
    case "membership_user_not_found":
    case "concurrency_error":
    case "user_role_assignments_invalid_format":
    case "role_invalid_uuid":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_invalid_structure":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "user_duplicate_roles":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

export function generateErrorResponseForGetGroup(
  error: GetGroupError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "group_update_before_create":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForListGroups(
  error: ListGroupsRepoError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "invalid_page":
    case "invalid_limit":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid page or limit`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_entities_count_invalid":
    case "group_description_too_long":
    case "group_update_before_create":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

type AddUserToGroupServiceError = ExtractLeftFromMethod<typeof GroupMembershipService, "addMembersToGroup">

export function generateErrorResponseForAddUserToGroup(
  error: AddUserToGroupServiceError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "request_invalid_group_uuid":
    case "request_invalid_user_uuid":
    case "request_invalid_user_identifier":
    case "user_invalid_uuid":
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "membership_entity_already_in_group":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Entity already in group`))
    case "concurrent_modification_error":
      return new ConflictException(generateErrorPayload(errorCode, context))
    case "membership_duplicated_membership":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Duplicated membership`))
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "group_update_before_create":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
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
    case "user_duplicate_roles":
    case "membership_inconsistent_dates":
    case "membership_invalid_entity_uuid":
    case "membership_group_not_found":
    case "membership_user_not_found":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
  }
}

type RemoveUserFromGroupServiceError = ExtractLeftFromMethod<typeof GroupMembershipService, "removeEntitiesFromGroup">

export function generateErrorResponseForRemoveUserFromGroup(
  error: RemoveUserFromGroupServiceError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: user not found`))
    case "membership_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: user is not a member of this group`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "membership_no_admin":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Cannot remove the last admin from a group`)
      )
    case "request_invalid_group_uuid":
    case "request_invalid_user_uuid":
    case "request_invalid_user_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "concurrent_modification_error":
      return new ConflictException(generateErrorPayload(errorCode, context))
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "group_update_before_create":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_invalid":
    case "user_email_too_long":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
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
    case "user_duplicate_roles":
    case "membership_inconsistent_dates":
    case "membership_invalid_entity_uuid":
    case "membership_duplicated_membership":
    case "user_invalid_uuid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
  }
}

type ListUsersInGroupServiceError = ExtractLeftFromMethod<
  typeof GroupMembershipService,
  "getGroupByIdentifierWithMembership"
>

export function generateErrorResponseForListUsersInGroup(
  error: "invalid_page" | "invalid_limit" | ListUsersInGroupServiceError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "invalid_page":
    case "invalid_limit":
    case "request_invalid_group_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "group_update_before_create":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
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
    case "user_duplicate_roles":
    case "membership_inconsistent_dates":
    case "membership_invalid_entity_uuid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
  }
}

function mapMembershipToListEntitiesItemApi(membership: Membership): ListGroupEntities200Response["entities"][number] {
  return {
    entity: {
      entityId: membership.getEntityId(),
      entityType: EntityType.HUMAN
    },
    addedAt: membership.createdAt.toISOString()
  }
}
