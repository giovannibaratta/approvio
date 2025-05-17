import {Group as GroupApi, GroupCreate, ListGroupEntities200Response, ListGroups200Response} from "@api"
import {EntityType, Role} from "@controllers/shared/types"
import {
  DESCRIPTION_MAX_LENGTH,
  Group as GroupDomain,
  GroupWithEntitiesCount,
  HumanGroupMembershipRole,
  Membership,
  MembershipValidationError,
  NAME_MAX_LENGTH,
  User
} from "@domain"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException
} from "@nestjs/common"
import {
  CreateGroupError,
  GetGroupError,
  GetGroupMembershipResult,
  ListGroupsRepoError,
  ListGroupsResult,
  MembershipAddError,
  MembershipRemoveError,
  AuthorizationError,
  CreateGroupRequest
} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"

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
    case "description_too_long":
      return new BadRequestException(
        generateErrorPayload(
          errorCode,
          `${context}: group description must be less than ${DESCRIPTION_MAX_LENGTH} characters`
        )
      )
    case "name_too_long":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: group name must be less than ${NAME_MAX_LENGTH} characters`)
      )
    case "name_empty":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: group name can not be empty`))
    case "name_invalid_characters":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: group name contains invalid characters`)
      )
    case "entities_count_invalid":
    case "update_before_create":
    case "org_role_invalid":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
      )
    case "group_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: group already exists`))
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Creator user not found`))
    case "invalid_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid UUID provided`))
    case "entity_already_in_group":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Entity already in group`))
    case "unknown_error":
    case "duplicated_membership":
    case "group_not_found":
    case "not_a_member":
    case "invalid_identifier":
    case "display_name_empty":
    case "display_name_too_long":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
    case "inconsistent_dates":
    case "invalid_role":
    case "concurrent_modification_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
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
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "description_too_long":
    case "entities_count_invalid":
    case "update_before_create":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
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
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "entities_count_invalid":
    case "description_too_long":
    case "update_before_create":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForAddUserToGroup(
  error: MembershipAddError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "entity_already_in_group":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: user is already a member of this group`)
      )
    case "invalid_role":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid role provided`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: user not found`))
    case "invalid_uuid":
    case "invalid_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid uuid`))
    case "display_name_empty":
    case "email_invalid":
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "update_before_create":
    case "description_too_long":
    case "display_name_too_long":
    case "entities_count_invalid":
    case "email_empty":
    case "email_too_long":
    case "org_role_invalid":
    case "inconsistent_dates":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
      )
    case "not_a_member":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "concurrent_modification_error":
    case "duplicated_membership":
      return new ConflictException(generateErrorPayload(errorCode, context))
  }
}

export function generateErrorResponseForRemoveUserFromGroup(
  error: MembershipRemoveError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: user not found`))
    case "entity_not_in_group":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: user is not a member of this group`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "invalid_role":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid role provided`))
    case "invalid_uuid":
    case "invalid_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid uuid`))
    case "display_name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "update_before_create":
    case "description_too_long":
    case "display_name_too_long":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
    case "entities_count_invalid":
    case "name_empty":
    case "org_role_invalid":
    case "inconsistent_dates":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency`)
      )
    case "unknown_error":
    case "not_a_member":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "concurrent_modification_error":
    case "duplicated_membership":
      return new ConflictException(generateErrorPayload(errorCode, context))
  }
}

export function generateErrorResponseForListUsersInGroup(
  error: "invalid_page" | "invalid_limit" | GetGroupError | MembershipValidationError | AuthorizationError,
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
    case "invalid_role":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid role provided`))
    case "invalid_uuid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid uuid`))
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "update_before_create":
    case "description_too_long":
    case "entities_count_invalid":
    case "not_a_member":
    case "inconsistent_dates":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: An unexpected error occurred`)
      )
    case "invalid_page":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid page`))
    case "invalid_limit":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid limit`))
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
