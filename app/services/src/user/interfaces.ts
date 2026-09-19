import {
  BoundaryError,
  Group,
  TenantContext,
  User,
  UserSummary,
  UserSummaryValidationError,
  UserValidationError
} from "@domain"
import {AuthorizationError, ConcurrentModificationError, UnknownError} from "@services/error"
import {Versioned} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {GetGroupRepoError} from "../group/interfaces"
import {TransactionError} from "../transaction/interfaces"

export type UserCreateError =
  BoundaryError | "user_already_exists" | AuthorizationError | UserValidationError | UnknownError | "quota_check_error"
export type UserGetError =
  BoundaryError | "user_not_found" | "request_invalid_user_identifier" | UserValidationError | UnknownError
export type UserUpdateError = UserGetError | ConcurrentModificationError

export type UserListValidationError =
  "invalid_page_number" | "invalid_limit_number" | "search_too_long" | "search_term_invalid_characters"
export type UserListError =
  BoundaryError | UserListValidationError | UserSummaryValidationError | UnknownError | TransactionError

export interface PaginatedUsersList {
  readonly users: ReadonlyArray<UserSummary>
  readonly page: number
  readonly limit: number
  readonly total: number
}

export const USER_REPOSITORY_TOKEN = "USER_REPOSITORY_TOKEN"

export interface UserRepository {
  createUser(context: TenantContext, user: User): TaskEither<UserCreateError, User>
  getUserById(context: TenantContext, userId: string): TaskEither<UserGetError, Versioned<User>>
  listUsers(context: TenantContext, params: ListUsersRepoRequest): TaskEither<UserListError, PaginatedUsersList>
  updateUser(context: TenantContext, user: Versioned<User>): TaskEither<UserUpdateError, Versioned<User>>
}

export interface ListUsersRepoRequest {
  readonly search?: string
  readonly page: number
  readonly limit: number
}

export type GetUserError = UserGetError | TransactionError | GetGroupRepoError

export interface UserDetails {
  readonly user: Versioned<User>
  readonly groups: Group[]
}
