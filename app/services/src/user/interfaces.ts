import {User, UserValidationError} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"

export type UserCreateError = "user_already_exists" | UserValidationError | UnknownError
export type UserGetError = "user_not_found" | "invalid_identifier" | UserValidationError | UnknownError

export const USER_REPOSITORY_TOKEN = "USER_REPOSITORY_TOKEN"

export interface UserRepository {
  createUser(user: User): TaskEither<UserCreateError, User>
  getUserById(userId: string): TaskEither<UserGetError, Versioned<User>>
  getUserByEmail(email: string): TaskEither<UserGetError, Versioned<User>>
}
