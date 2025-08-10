import {Either, left, right, isLeft} from "fp-ts/Either"
import {randomUUID} from "crypto"
import {getStringAsEnum, isEmail, isUUIDv4, PrefixUnion} from "@utils"
import {BoundRole, RoleFactory, RoleValidationError, SpaceScope, GroupScope, WorkflowTemplateScope} from "./role"

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
  roles: ReadonlyArray<BoundRole<string>>
}

type EmailValidationError = "email_empty" | "email_too_long" | "email_invalid"
type DisplayNameValidationError = "display_name_empty" | "display_name_too_long"
type OrgValidationError = "org_role_invalid"
type IdValidationError = "invalid_uuid"
type RoleAssignmentValidationError = "role_assignments_invalid_format" | "duplicate_roles"

export type UserValidationError = PrefixUnion<"user", UnprefixedUserValidationError> | RoleValidationError
export type UserSummaryValidationError = PrefixUnion<"user", UnprefixedUserSummaryValidationError>

type UnprefixedUserValidationError =
  | UnprefixedUserSummaryValidationError
  | OrgValidationError
  | RoleAssignmentValidationError
type UnprefixedUserSummaryValidationError = IdValidationError | DisplayNameValidationError | EmailValidationError

export class UserFactory {
  /**
   * Adds new permissions to a user, validating that they are not duplicated with existing ones
   * @param user The user to add permissions to
   * @param newRoles Array of new bound roles to add
   * @returns Either validation error or user with updated permissions
   */
  static addPermissions(user: User, newRoles: ReadonlyArray<BoundRole<string>>): Either<UserValidationError, User> {
    const updatedUser: User = {
      ...user,
      roles: [...user.roles, ...newRoles]
    }

    return UserFactory.validate(updatedUser)
  }

  /**
   * Validates role assignments from external data
   * @param roles Array data that should represent BoundRole array
   * @returns Either validation error or validated roles array
   */
  static validateRoles(roles: unknown): Either<UserValidationError, ReadonlyArray<BoundRole<string>>> {
    if (roles === null || roles === undefined) return right([])
    if (!Array.isArray(roles)) return left("user_role_assignments_invalid_format")

    return RoleFactory.validateBoundRoles(roles)
  }

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
    data: Omit<User, "id" | "createdAt" | "orgRole" | "roles"> & {orgRole: string}
  ): Either<UserValidationError, User> {
    const uuid = randomUUID()
    const now = new Date()

    const validatedOrgRole = validateOrgRole(data.orgRole)
    if (isLeft(validatedOrgRole)) return validatedOrgRole

    const user: User = {
      ...data,
      id: uuid,
      createdAt: now,
      orgRole: validatedOrgRole.right,
      roles: []
    }

    return UserFactory.validate(user)
  }

  /**
   * Performs the core validation logic for a User object.
   * @param data The User object data.
   * @returns Either a validation error or the validated User object.
   */
  private static createUser(
    data: Omit<User, "orgRole" | "roles"> & {
      readonly orgRole: User["orgRole"] | string
      readonly roles: User["roles"] | unknown
    }
  ): Either<UserValidationError, User> {
    const userSummaryValidation = this.createUserSummary(data)
    const orgRoleValidation = typeof data.orgRole === "string" ? validateOrgRole(data.orgRole) : right(data.orgRole)
    const rolesValidation = this.validateRoles(data.roles)

    if (isLeft(userSummaryValidation)) return userSummaryValidation
    if (isLeft(orgRoleValidation)) return orgRoleValidation
    if (isLeft(rolesValidation)) return rolesValidation

    const duplicateCheck = this.checkForDuplicateRoles(rolesValidation.right)
    if (isLeft(duplicateCheck)) return duplicateCheck

    return right({
      ...userSummaryValidation.right,
      orgRole: orgRoleValidation.right,
      createdAt: data.createdAt,
      roles: rolesValidation.right
    })
  }

  /**
   * Checks for duplicate roles (same name and scope combination)
   * @param roles Array of roles to check for duplicates
   * @returns Either validation error if duplicates found or success
   */
  private static checkForDuplicateRoles(roles: ReadonlyArray<BoundRole<string>>): Either<UserValidationError, void> {
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        const roleI = roles[i]
        const roleJ = roles[j]
        if (roleI && roleJ && roleI.name === roleJ.name && this.isSameScope(roleI.scope, roleJ.scope)) {
          return left("user_duplicate_roles")
        }
      }
    }
    return right(undefined)
  }

  /**
   * Helper function to compare two role scopes for equality
   * @param scope1 First scope to compare
   * @param scope2 Second scope to compare
   * @returns true if scopes are equal, false otherwise
   */
  private static isSameScope(scope1: BoundRole<string>["scope"], scope2: BoundRole<string>["scope"]): boolean {
    if (scope1.type !== scope2.type) return false

    switch (scope1.type) {
      case "org":
        return true
      case "space":
        return scope1.spaceId === (scope2 as SpaceScope).spaceId
      case "group":
        return scope1.groupId === (scope2 as GroupScope).groupId
      case "workflow_template":
        return scope1.workflowTemplateId === (scope2 as WorkflowTemplateScope).workflowTemplateId
    }
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

function validateDisplayName(displayName: string): Either<UserSummaryValidationError, string> {
  if (!displayName || displayName.trim().length === 0) return left("user_display_name_empty")
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) return left("user_display_name_too_long")

  return right(displayName)
}

function validateEmail(email: string): Either<UserSummaryValidationError, string> {
  if (!email || email.trim().length === 0) return left("user_email_empty")
  if (email.length > EMAIL_MAX_LENGTH) return left("user_email_too_long")
  if (!isEmail(email)) return left("user_email_invalid")

  return right(email)
}

function validateOrgRole(orgRole: string): Either<UserValidationError, OrgRole> {
  const enumOrgRole = getStringAsEnum(orgRole, OrgRole)
  if (enumOrgRole === undefined) return left("user_org_role_invalid")
  return right(enumOrgRole)
}

function validateId(id: string): Either<UserSummaryValidationError, string> {
  if (!isUUIDv4(id)) return left("user_invalid_uuid")
  return right(id)
}
