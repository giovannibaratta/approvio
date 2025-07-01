import {Group as GroupApi, GroupCreate, ListGroupEntities200Response, ListGroups200Response} from "@approvio/api"
import {EntityType, Role} from "@controllers/shared/types"
import {
  DESCRIPTION_MAX_LENGTH,
  Group as GroupDomain,
  GroupWithEntitiesCount,
  HumanGroupMembershipRole,
  Membership,
  NAME_MAX_LENGTH,
  User
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
  GroupMembershipService
} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"
import {ExtractLeftFromMethod} from "@utils"

export type CreateGroupRequestValidationError = never

export function createGroupApiToServiceModel(data: {
  request: GroupCreate
  requestor: User
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
    case "not_a_member":
    case "invalid_identifier":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "membership_invalid_role":
    case "membership_inconsistent_dates":
    case "membership_invalid_user_uuid":
    case "concurrent_modification_error":
    case "membership_group_not_found":
    case "membership_user_not_found":
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
    case "not_a_member":
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
    case "membership_invalid_role":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid role provided`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "invalid_identifier":
    case "request_invalid_group_uuid":
    case "request_invalid_user_uuid":
    case "membership_user_not_found":
    case "user_invalid_uuid":
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "user_display_name_empty":
    case "user_email_invalid":
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_update_before_create":
    case "group_description_too_long":
    case "user_display_name_too_long":
    case "group_entities_count_invalid":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_org_role_invalid":
    case "membership_inconsistent_dates":
    case "membership_invalid_user_uuid":
    case "membership_group_not_found":
    case "membership_duplicated_membership":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "not_a_member":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "concurrent_modification_error":
    case "membership_entity_already_in_group":
      return new ConflictException(generateErrorPayload(errorCode, context))
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
    case "membership_no_owner":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Cannot remove the last owner from a group`)
      )
    case "user_invalid_uuid":
    case "invalid_identifier":
    case "request_invalid_group_uuid":
    case "request_invalid_user_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "group_name_empty":
    case "group_name_invalid_characters":
    case "group_name_too_long":
    case "group_update_before_create":
    case "membership_inconsistent_dates":
    case "membership_invalid_user_uuid":
    case "membership_invalid_role":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_invalid":
    case "user_email_too_long":
    case "user_org_role_invalid":
    case "membership_duplicated_membership":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
    case "not_a_member":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "concurrent_modification_error":
      return new ConflictException(generateErrorPayload(errorCode, context))
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
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_update_before_create":
    case "group_description_too_long":
    case "group_entities_count_invalid":
    case "not_a_member":
    case "membership_inconsistent_dates":
    case "membership_invalid_user_uuid":
    case "membership_invalid_role":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "invalid_page":
    case "request_invalid_group_uuid":
    case "invalid_limit":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
  }
}

function mapMembershipToListEntitiesItemApi(membership: Membership): ListGroupEntities200Response["entities"][number] {
  return {
    entity: {
      entityId: membership.getEntityId(),
      entityType: EntityType.HUMAN
    },
    role: mapDomainRoleToApiRole(membership.role),
    addedAt: membership.createdAt.toISOString()
  }
}

function mapDomainRoleToApiRole(role: HumanGroupMembershipRole): Role {
  switch (role) {
    case HumanGroupMembershipRole.ADMIN:
      return Role.ADMIN
    case HumanGroupMembershipRole.APPROVER:
      return Role.APPROVER
    case HumanGroupMembershipRole.AUDITOR:
      return Role.AUDITOR
    case HumanGroupMembershipRole.OWNER:
      return Role.OWNER
  }
}
