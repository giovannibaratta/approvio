import {User, UserSummary, UserSummaryValidationError, UserValidationError} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"
import {Versioned} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"

export type UserCreateError = "user_already_exists" | AuthorizationError | UserValidationError | UnknownError
export type UserGetError = "user_not_found" | "request_invalid_user_identifier" | UserValidationError | UnknownError

export type UserListValidationError =
  | "invalid_page_number"
  | "invalid_limit_number"
  | "search_too_long"
  | "search_term_invalid_characters"
export type UserListError = UserListValidationError | UserSummaryValidationError | UnknownError

export interface PaginatedUsersList {
  readonly users: ReadonlyArray<UserSummary>
  readonly page: number
  readonly limit: number
  readonly total: number
}

export const USER_REPOSITORY_TOKEN = "USER_REPOSITORY_TOKEN"

export interface UserRepository {
  createUser(user: User): TaskEither<UserCreateError, User>
  getUserById(userId: string): TaskEither<UserGetError, Versioned<User>>
  getUserByEmail(email: string): TaskEither<UserGetError, Versioned<User>>
  listUsers(params: ListUsersRepoRequest): TaskEither<UserListError, PaginatedUsersList>
}

export interface ListUsersRepoRequest {
  readonly search?: string
  readonly page: number
  readonly limit: number
}
