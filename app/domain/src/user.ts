import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {isEmail} from "./utils"

export const DISPLAY_NAME_MAX_LENGTH = 255
export const EMAIL_MAX_LENGTH = 255

export type User = Readonly<PrivateUser>

interface PrivateUser {
  id: string
  displayName: string
  email: string
  createdAt: Date
}

export type CreateUserRequest = Omit<User, "id" | "createdAt">

export type UserValidationError =
  | "display_name_empty"
  | "display_name_too_long"
  | "email_empty"
  | "email_too_long"
  | "email_invalid"

export class UserFactory {
  /**
   * Validates an existing User object.
   * @param data The User object to validate.
   * @returns Either a validation error or the valid User object.
   */
  static validate(data: User): Either<UserValidationError, User> {
    return UserFactory.createUser(data)
  }

  /**
   * Creates a new User object with validation.
   * Generates a UUID and sets the creation timestamp.
   * @param data Request data for creating a user.
   * @returns Either a validation error or the newly created User object.
   */
  static newUser(data: CreateUserRequest): Either<UserValidationError, User> {
    const uuid = randomUUID()
    const now = new Date()
    const user: User = {
      ...data,
      id: uuid,
      createdAt: now
    }

    return UserFactory.validate(user)
  }

  /**
   * Performs the core validation logic for a User object.
   * @param data The User object data.
   * @returns Either a validation error or the validated User object.
   */
  private static createUser(data: User): Either<UserValidationError, User> {
    const displayNameValidation = validateDisplayName(data.displayName)
    const emailValidation = validateEmail(data.email)

    if (isLeft(displayNameValidation)) return displayNameValidation
    if (isLeft(emailValidation)) return emailValidation

    return right({
      ...data,
      displayName: displayNameValidation.right,
      email: emailValidation.right
    })
  }
}

function validateDisplayName(displayName: string): Either<UserValidationError, string> {
  if (!displayName || displayName.trim().length === 0) return left("display_name_empty")
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) return left("display_name_too_long")

  return right(displayName)
}

function validateEmail(email: string): Either<UserValidationError, string> {
  if (!email || email.trim().length === 0) return left("email_empty")
  if (email.length > EMAIL_MAX_LENGTH) return left("email_too_long")
  if (!isEmail(email)) return left("email_invalid")

  return right(email)
}
