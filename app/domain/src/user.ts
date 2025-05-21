import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {getStringAsEnum, isEmail, isUUIDv4} from "@utils"

export const DISPLAY_NAME_MAX_LENGTH = 255
export const EMAIL_MAX_LENGTH = 255

export enum OrgRole {
  ADMIN = "admin",
  MEMBER = "member"
}

export type User = Readonly<PrivateUser>
export type UserSummary = Readonly<UserSummaryData>

interface UserSummaryData {
  id: string
  displayName: string
  email: string
}

interface PrivateUser extends UserSummaryData {
  createdAt: Date
  orgRole: OrgRole
}

type EmailValidationError = "email_empty" | "email_too_long" | "email_invalid"
type DisplayNameValidationError = "display_name_empty" | "display_name_too_long"
type OrgValidationError = "org_role_invalid"
type IdValidationError = "invalid_uuid"

export type UserValidationError = UserSummaryValidationError | OrgValidationError
export type UserSummaryValidationError = IdValidationError | DisplayNameValidationError | EmailValidationError

export class UserFactory {
  /**
   * Validates an existing User object.
   * @param data The User object to validate.
   * @returns Either a validation error or the valid User object.
   */
  static validate(data: Parameters<typeof UserFactory.createUser>[0]): Either<UserValidationError, User> {
    return UserFactory.createUser(data)
  }

  static validateUserSummary(
    data: Parameters<typeof UserFactory.createUserSummary>[0]
  ): Either<UserSummaryValidationError, UserSummary> {
    return UserFactory.createUserSummary(data)
  }

  /**
   * Creates a new User object with validation.
   * Generates a UUID and sets the creation timestamp.
   * @param data Request data for creating a user.
   * @returns Either a validation error or the newly created User object.
   */
  static newUser(
    data: Omit<User, "id" | "createdAt" | "orgRole"> & {orgRole: string}
  ): Either<UserValidationError, User> {
    const uuid = randomUUID()
    const now = new Date()

    const validatedOrgRole = validateOrgRole(data.orgRole)
    if (isLeft(validatedOrgRole)) return validatedOrgRole

    const user: User = {
      ...data,
      id: uuid,
      createdAt: now,
      orgRole: validatedOrgRole.right
    }

    return UserFactory.validate(user)
  }

  /**
   * Performs the core validation logic for a User object.
   * @param data The User object data.
   * @returns Either a validation error or the validated User object.
   */
  private static createUser(
    data: Omit<User, "orgRole"> & {readonly orgRole: OrgRole | string}
  ): Either<UserValidationError, User> {
    const userSummaryValidation = this.createUserSummary(data)
    const orgRoleValidation = typeof data.orgRole === "string" ? validateOrgRole(data.orgRole) : right(data.orgRole)

    if (isLeft(userSummaryValidation)) return userSummaryValidation
    if (isLeft(orgRoleValidation)) return orgRoleValidation

    return right({
      ...userSummaryValidation.right,
      orgRole: orgRoleValidation.right,
      createdAt: data.createdAt
    })
  }

  private static createUserSummary(data: UserSummaryData): Either<UserSummaryValidationError, UserSummary> {
    const displayNameValidation = validateDisplayName(data.displayName)
    const emailValidation = validateEmail(data.email)
    const idValidation = validateId(data.id)

    if (isLeft(idValidation)) return idValidation
    if (isLeft(displayNameValidation)) return displayNameValidation
    if (isLeft(emailValidation)) return emailValidation

    return right({
      id: idValidation.right,
      displayName: displayNameValidation.right,
      email: emailValidation.right
    })
  }
}

function validateDisplayName(displayName: string): Either<DisplayNameValidationError, string> {
  if (!displayName || displayName.trim().length === 0) return left("display_name_empty")
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) return left("display_name_too_long")

  return right(displayName)
}

function validateEmail(email: string): Either<EmailValidationError, string> {
  if (!email || email.trim().length === 0) return left("email_empty")
  if (email.length > EMAIL_MAX_LENGTH) return left("email_too_long")
  if (!isEmail(email)) return left("email_invalid")

  return right(email)
}

function validateOrgRole(orgRole: string): Either<OrgValidationError, OrgRole> {
  const enumOrgRole = getStringAsEnum(orgRole, OrgRole)
  if (enumOrgRole === undefined) return left("org_role_invalid")
  return right(enumOrgRole)
}

function validateId(id: string): Either<IdValidationError, string> {
  if (!isUUIDv4(id)) return left("invalid_uuid")
  return right(id)
}
