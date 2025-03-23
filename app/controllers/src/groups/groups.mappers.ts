import {GroupCreate} from "@api"
import {CreateGroupRequest, DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH} from "@domain"
import {Either, right} from "fp-ts/Either"
import {BadRequestException, HttpException, InternalServerErrorException} from "@nestjs/common"
import {generateErrorPayload} from "../error"
import {CreateGroupError} from "@services"

export type CreateGroupRequestValidationError = never

export function createGroupApiToServiceModel(
  request: GroupCreate
): Either<CreateGroupRequestValidationError, CreateGroupRequest> {
  return right({
    description: request.description ?? null,
    name: request.name
  })
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
