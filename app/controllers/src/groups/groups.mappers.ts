import {Group as GroupApi, GroupCreate, ListGroups200Response} from "@api"
import {CreateGroupRequest, DESCRIPTION_MAX_LENGTH, Group as GroupDomain, NAME_MAX_LENGTH} from "@domain"
import {BadRequestException, HttpException, InternalServerErrorException, NotFoundException} from "@nestjs/common"
import {CreateGroupError, GroupGetError, GroupListError, ListGroupsResult} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"

export type CreateGroupRequestValidationError = never

export function createGroupApiToServiceModel(
  request: GroupCreate
): Either<CreateGroupRequestValidationError, CreateGroupRequest> {
  return right({
    description: request.description ?? null,
    name: request.name
  })
}

export function mapGroupToApi(group: GroupDomain): GroupApi {
  return {
    id: group.id,
    name: group.name,
    description: group.description ?? undefined,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    entitiesCount: 0
  }
}

export function mapListGroupsResultToApi(result: ListGroupsResult): ListGroups200Response {
  return {
    groups: result.groups.map(mapGroupToApi),
    pagination: {
      total: result.total,
      page: result.page,
      limit: result.limit
    }
  }
}

export function generateErrorResponseForCreateGroup(error: CreateGroupError, context: string): HttpException {
  const errorCode = error.toLocaleUpperCase()

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
    case "update_before_create":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}`))
    case "group_already_exists":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: group already exists`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}`))
  }
}

export function generateErrorResponseForGetGroup(error: GroupGetError, context: string): HttpException {
  const errorCode = error.toLocaleUpperCase()

  switch (error) {
    case "group_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: group not found`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}`))
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "update_before_create":
    case "description_too_long":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid data detected`))
  }
}

export function generateErrorResponseForListGroups(error: GroupListError, context: string): HttpException {
  const errorCode = error.toLocaleUpperCase()

  switch (error) {
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}`))
    case "invalid_page":
    case "invalid_limit":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid page or limit`))
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "update_before_create":
    case "description_too_long":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid data detected`))
  }
}
