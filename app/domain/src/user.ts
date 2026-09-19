import {Either, isLeft, left, right} from "fp-ts/Either"

import {getStringAsEnum, isUUIDv7, PrefixUnion} from "@utils"
import {MAX_ROLES_PER_ENTITY, RoleFactory, RoleValidationError, UnconstrainedBoundRole} from "./role"
import {TenantContext, Versioned} from "./shared"

export const DISPLAY_NAME_MAX_LENGTH = 255

export enum OrgRole {
  OWNER = "owner",
  ADMIN = "admin",
  MEMBER = "member"
}

export enum MembershipStatus {
  ACTIVE = "active",
  REMOVED = "removed"
}

export interface User extends TenantContext {
  readonly id: string
  readonly accountId: string
  readonly displayName: string
  readonly status: MembershipStatus
  readonly orgRole: OrgRole
  readonly roles: ReadonlyArray<UnconstrainedBoundRole>
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface UserSummaryData extends TenantContext {
  id: string
  accountId: string
  displayName: string
  status: MembershipStatus
  orgRole: OrgRole
}

export type UserSummary = Readonly<UserSummaryData>

type UnprefixedUserIdentityValidationError =
  "invalid_uuid" | "invalid_organization_id" | "invalid_account_id" | "display_name_empty" | "display_name_too_long"

type UserIdentityValidationError = PrefixUnion<"user", UnprefixedUserIdentityValidationError>

type UnprefixedUserFieldValidationError =
  | UnprefixedUserIdentityValidationError
  | "org_role_invalid"
  | "status_invalid"
  | "update_before_create"
  | "role_assignments_invalid_format"
  | "duplicate_roles"
  | "role_organization_mismatch"
  | "membership_roles_invalid"

type UserFieldValidationError = PrefixUnion<"user", UnprefixedUserFieldValidationError>

export type UserValidationError = UserFieldValidationError | RoleValidationError
export type UserSummaryValidationError =
  UserIdentityValidationError | PrefixUnion<"user", "org_role_invalid" | "status_invalid">
export type MembershipTransitionError = "user_invalid_membership_transition"

export class UserFactory {
  /**
   * Adds new permissions to a user, validating that they are not duplicated with existing ones
   * @param user The user to add permissions to
   * @param newRoles Array of new bound roles to add
   * @returns Either validation error or user with updated permissions
   */
  static addPermissions(
    user: User,
    newRoles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, User> {
    return UserFactory.assignRoles(user, newRoles)
  }

  /**
   * Validates role assignments from external data.
   * @param roles Array data that should represent bound roles.
   * @returns Either validation error or validated roles.
   */
  static validateRoles(roles: unknown): Either<UserValidationError, ReadonlyArray<UnconstrainedBoundRole>> {
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

  static assignRoles(user: User, newRoles: ReadonlyArray<UnconstrainedBoundRole>): Either<UserValidationError, User>
  static assignRoles(
    user: Versioned<User>,
    newRoles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, Versioned<User>>
  static assignRoles(
    user: User | Versioned<User>,
    newRoles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, User | Versioned<User>> {
    const roles = RoleFactory.consolidateRoles([...user.roles, ...newRoles])
    if (roles.length > MAX_ROLES_PER_ENTITY) return left("role_total_roles_exceed_maximum")

    return validateRoleUpdate(user, roles)
  }

  /**
   * Creates a new User with specified roles removed
   * @param user Existing user (can be regular User or Versioned<User>)
   * @param rolesToRemove Array of roles to remove (matched by name and scope)
   * @returns Either validation error or new User/Versioned<User> with roles removed
   */
  static removeRoles(
    user: User,
    rolesToRemove: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, User>
  static removeRoles(
    user: Versioned<User>,
    rolesToRemove: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, Versioned<User>>
  static removeRoles(
    user: User | Versioned<User>,
    rolesToRemove: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, User | Versioned<User>> {
    const roles = user.roles.filter(
      existing =>
        !rolesToRemove.some(
          candidate => existing.name === candidate.name && RoleFactory.isSameScope(existing.scope, candidate.scope)
        )
    )
    return validateRoleUpdate(user, roles)
  }

  static remove(user: User): Either<MembershipTransitionError, User> {
    if (user.status !== MembershipStatus.ACTIVE) return left("user_invalid_membership_transition")
    return right({...user, status: MembershipStatus.REMOVED, roles: [], updatedAt: new Date()})
  }

  static readmit(user: User, orgRole: OrgRole): Either<MembershipTransitionError, User> {
    if (user.status !== MembershipStatus.REMOVED) return left("user_invalid_membership_transition")
    return right({...user, status: MembershipStatus.ACTIVE, orgRole, roles: [], updatedAt: new Date()})
  }

  static canGrantOrgRole(actor: User, target: User, requestedRole: OrgRole): boolean {
    if (actor.organizationId !== target.organizationId) return false
    if (actor.status !== MembershipStatus.ACTIVE || target.status !== MembershipStatus.ACTIVE) return false
    if (actor.orgRole === OrgRole.OWNER) return true
    if (actor.orgRole !== OrgRole.ADMIN) return false
    return target.orgRole !== OrgRole.OWNER && requestedRole !== OrgRole.OWNER
  }

  private static createUser(
    data: Omit<User, "orgRole" | "roles" | "status"> & {
      readonly orgRole: unknown
      readonly status: unknown
      readonly roles: unknown
    }
  ): Either<UserValidationError, User> {
    const userSummaryValidation = UserFactory.createUserSummary(data)
    const rolesValidation = UserFactory.validateRoles(data.roles)

    if (isLeft(userSummaryValidation)) return userSummaryValidation
    if (isLeft(rolesValidation)) return rolesValidation
    if (data.createdAt > data.updatedAt) return left("user_update_before_create")
    if (rolesValidation.right.some(role => role.scope.organizationId !== data.organizationId))
      return left("user_role_organization_mismatch")
    if (userSummaryValidation.right.status === MembershipStatus.REMOVED && rolesValidation.right.length > 0)
      return left("user_membership_roles_invalid")

    const duplicateCheck = UserFactory.checkForDuplicateRoles(rolesValidation.right)
    if (isLeft(duplicateCheck)) return duplicateCheck

    return right({
      ...userSummaryValidation.right,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      roles: rolesValidation.right
    })
  }

  /**
   * Checks for duplicate roles (same name and scope combination)
   * @param roles Array of roles to check for duplicates
   * @returns Either validation error if duplicates found or success
   */
  private static checkForDuplicateRoles(
    roles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<UserValidationError, void> {
    for (let i = 0; i < roles.length; i++)
      for (let j = i + 1; j < roles.length; j++) {
        const roleI = roles[i]
        const roleJ = roles[j]
        if (roleI && roleJ && roleI.name === roleJ.name && RoleFactory.isSameScope(roleI.scope, roleJ.scope))
          return left("user_duplicate_roles")
      }

    return right(undefined)
  }

  private static createUserSummary(data: UserSummaryInput): Either<UserSummaryValidationError, UserSummary> {
    const identityValidation = validateUserIdentity(data)
    const orgRoleValidation = validateOrgRole(data.orgRole)
    const statusValidation = validateMembershipStatus(data.status)

    if (isLeft(identityValidation)) return identityValidation
    if (isLeft(orgRoleValidation)) return orgRoleValidation
    if (isLeft(statusValidation)) return statusValidation

    return right({
      ...identityValidation.right,
      orgRole: orgRoleValidation.right,
      status: statusValidation.right
    })
  }
}

type UserSummaryInput = Omit<UserSummaryData, "orgRole" | "status"> & {
  readonly orgRole: unknown
  readonly status: unknown
}

function validateMembershipStatus(status: unknown): Either<UserSummaryValidationError, MembershipStatus> {
  if (typeof status !== "string") return left("user_status_invalid")
  const validatedStatus = getStringAsEnum(status, MembershipStatus)
  if (validatedStatus === undefined) return left("user_status_invalid")
  return right(validatedStatus)
}

function validateOrgRole(orgRole: unknown): Either<UserSummaryValidationError, OrgRole> {
  if (typeof orgRole !== "string") return left("user_org_role_invalid")
  const validatedOrgRole = getStringAsEnum(orgRole, OrgRole)
  if (validatedOrgRole === undefined) return left("user_org_role_invalid")
  return right(validatedOrgRole)
}

function validateRoleUpdate(
  user: User | Versioned<User>,
  roles: ReadonlyArray<UnconstrainedBoundRole>
): Either<UserValidationError, User | Versioned<User>> {
  const validation = UserFactory.validate({...user, roles})
  return isLeft(validation) ? validation : right({...user, roles})
}

function validateUserIdentity(
  data: Pick<User, "id" | "organizationId" | "accountId" | "displayName">
): Either<UserIdentityValidationError, Pick<User, "id" | "organizationId" | "accountId" | "displayName">> {
  if (!isUUIDv7(data.id)) return left("user_invalid_uuid")
  if (!isUUIDv7(data.organizationId)) return left("user_invalid_organization_id")
  if (!isUUIDv7(data.accountId)) return left("user_invalid_account_id")
  if (!data.displayName.trim()) return left("user_display_name_empty")
  if (data.displayName.length > DISPLAY_NAME_MAX_LENGTH) return left("user_display_name_too_long")
  return right(data)
}
