import {ListUsers200Response, User as UserApi, UserCreate} from "@api"
import {User, User as UserDomain} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import {
  AuthorizationError,
  CreateUserRequest,
  PaginatedUsersList,
  UserCreateError,
  UserGetError,
  UserListError
} from "@services"
import {Either, right} from "fp-ts/Either"
import {generateErrorPayload} from "../error"

export function createUserApiToServiceModel(data: {
  userData: UserCreate
  requestor: User
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
    createdAt: user.createdAt.toISOString()
  }
}

export function generateErrorResponseForCreateUser(
  error: UserCreateError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "display_name_empty":
    case "display_name_too_long":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid user data`))
    case "user_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: User with this email already exists`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "invalid_uuid":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "org_role_invalid":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Internal data inconsistency - invalid org role`)
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
    case "invalid_uuid":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
    case "display_name_empty":
    case "display_name_too_long":
    case "org_role_invalid":
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
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
    case "invalid_uuid":
    case "display_name_empty":
    case "display_name_too_long":
    case "email_empty":
    case "email_too_long":
    case "email_invalid":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}
