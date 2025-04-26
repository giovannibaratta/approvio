import {User as UserApi, UserCreate} from "@api"
import {CreateUserRequest, User as UserDomain} from "@domain"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import {UserCreateError, UserGetError} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"

export function createUserApiToServiceModel(request: UserCreate): Either<never, CreateUserRequest> {
  return right({
    displayName: request.displayName,
    email: request.email
  })
}

export function mapUserToApi(user: UserDomain): UserApi {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    createdAt: user.createdAt.toISOString()
  }
}

export function generateErrorResponseForCreateUser(error: UserCreateError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "display_name_empty":
    case "display_name_too_long":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Invalid user data - ${error.replace(/_/g, " ")}`)
      )
    case "user_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: User with this email already exists`))

    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForGetUser(error: UserGetError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "user_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "invalid_identifier":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid identifier`))
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
    case "display_name_empty":
    case "display_name_too_long":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}
