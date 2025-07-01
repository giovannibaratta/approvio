import {Group, User} from "@domain"
import {getStringAsEnum, isUUIDv4, PrefixUnion} from "@utils"
import * as A from "fp-ts/Array"
import {Applicative, Do, Either, isLeft, left, right, chain, bindW} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"

export enum HumanGroupMembershipRole {
  ADMIN = "admin",
  APPROVER = "approver",
  AUDITOR = "auditor",
  OWNER = "owner"
}

export type Membership = Readonly<PrivateMembership>
export type MembershipWithGroupRef = Readonly<PrivateMembershipWithGroupRef>

type UserReference = string
type RoleValidationError = "invalid_role"
export type MembershipValidationError = PrefixUnion<"membership", UnprefixedMembershipValidationError>
export type MembershipValidationErrorWithGroupRef = PrefixUnion<
  "membership",
  UnprefixedMembershipValidationErrorWithGroupRef
>
type UserValidationReferenceError = "invalid_user_uuid"
type GroupValidationReferenceError = "invalid_group_uuid"

type UnprefixedMembershipValidationError = RoleValidationError | UserValidationReferenceError | "inconsistent_dates"
type UnprefixedMembershipValidationErrorWithGroupRef =
  | UnprefixedMembershipValidationError
  | GroupValidationReferenceError

interface PrivateMembershipWithGroupRef extends PrivateMembership {
  groupId: string
}

interface PrivateMembership {
  entity: User | UserReference
  role: HumanGroupMembershipRole
  createdAt: Date
  updatedAt: Date

  getEntityId(): string
}

function validateRole(role: string): Either<MembershipValidationError, HumanGroupMembershipRole> {
  const enumRole = getStringAsEnum(role, HumanGroupMembershipRole)
  if (enumRole === undefined) return left("membership_invalid_role")
  return right(enumRole)
}

function validateGroupReference(groupReference: string): Either<MembershipValidationErrorWithGroupRef, string> {
  if (!isUUIDv4(groupReference)) return left("membership_invalid_group_uuid")
  return right(groupReference)
}

function validateUserReference(userReference: string | User): Either<MembershipValidationError, UserReference | User> {
  if (typeof userReference === "string" && !isUUIDv4(userReference)) return left("membership_invalid_user_uuid")
  return right(userReference)
}

export class MembershipFactory {
  static validate(
    data: Parameters<typeof MembershipFactory.semanticValidation>[0]
  ): Either<MembershipValidationError, Membership> {
    return MembershipFactory.semanticValidation(data)
  }

  static validateWithGroupRef(
    data: Parameters<typeof MembershipFactory.validate>[0] & {groupId: string}
  ): Either<MembershipValidationErrorWithGroupRef, MembershipWithGroupRef> {
    const validatedObject = pipe(
      Do,
      bindW("membership", () => MembershipFactory.validate(data)),
      bindW("groupId", () => validateGroupReference(data.groupId)),
      chain(({membership, groupId}) => {
        return right({
          ...membership,
          groupId
        })
      })
    )

    return validatedObject
  }

  static newMembership(data: {user: string; role: string}): Either<MembershipValidationError, Membership> {
    const now = new Date()
    return MembershipFactory.semanticValidation({
      role: data.role,
      entity: data.user,
      createdAt: now,
      updatedAt: now
    })
  }

  private static semanticValidation(
    data: Omit<Membership, "getEntityId" | "role"> & {role: string}
  ): Either<MembershipValidationError, Membership> {
    const roleValidation = validateRole(data.role)
    const userValidation = validateUserReference(data.entity)

    if (isLeft(roleValidation)) return left(roleValidation.left)
    if (isLeft(userValidation)) return left(userValidation.left)
    if (data.createdAt > data.updatedAt) return left("membership_inconsistent_dates")

    return right({
      entity: userValidation.right,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      role: roleValidation.right,
      getEntityId: () => getEntityId(userValidation.right)
    })
  }
}

function getEntityId(entity: PrivateMembership["entity"]): EntityId {
  return typeof entity === "string" ? entity : entity.id
}

export type GroupManagerValidationError = PrefixUnion<"membership", "duplicated_membership">
export type AddMembershipError = PrefixUnion<"membership", "entity_already_in_group">
export type RemoveMembershipError = PrefixUnion<"membership", "not_found" | "no_owner">
export type UpdateMembershipError = RemoveMembershipError

type EntityId = string

export class GroupManager {
  private readonly memberships: Map<EntityId, Membership> = new Map()

  private constructor(
    readonly group: Group,
    memberships: ReadonlyArray<Membership>
  ) {
    memberships.forEach(m => this.memberships.set(m.getEntityId(), m))
  }

  getMemberships(): ReadonlyArray<Membership> {
    return Array.from(this.memberships.values())
  }

  addMembership(membershipToAdd: Membership): Either<AddMembershipError, GroupManager> {
    const entityId = membershipToAdd.getEntityId()
    if (this.isEntityInMembership(entityId)) return left("membership_entity_already_in_group")

    this.memberships.set(entityId, membershipToAdd)
    return right(this)
  }

  addMemberships(membershipsToAdd: ReadonlyArray<Membership>): Either<AddMembershipError, GroupManager> {
    const result = pipe([...membershipsToAdd], A.traverse(Applicative)(this.addMembership))
    if (isLeft(result)) return result
    return right(this)
  }

  isEntityInMembership(entityId: EntityId): boolean {
    return this.memberships.has(entityId)
  }

  isEntityInMembershipWithRole(
    entityId: EntityId,
    role: HumanGroupMembershipRole | HumanGroupMembershipRole[]
  ): boolean {
    const membership = this.memberships.get(entityId)
    const admissibleRoles = Array.isArray(role) ? role : [role]
    return membership !== undefined && admissibleRoles.includes(membership.role)
  }

  removeMembership(entityId: string): Either<RemoveMembershipError, GroupManager> {
    if (!this.isEntityInMembership(entityId)) return left("membership_not_found")

    // Check if removing this member would leave the group without an owner
    const membershipToRemove = this.memberships.get(entityId)

    if (membershipToRemove === undefined) return left("membership_not_found")

    if (membershipToRemove.role === HumanGroupMembershipRole.OWNER) {
      const remainingOwners = Array.from(this.memberships.values()).filter(
        m => m.role === HumanGroupMembershipRole.OWNER && m.getEntityId() !== entityId
      )
      if (remainingOwners.length === 0)
        // Removing the entity would leave the group without an owner, which is not allowed
        return left("membership_no_owner")
    }

    this.memberships.delete(entityId)
    return right(this)
  }

  canUpdateMembership(requestor: User): boolean {
    return this.canAdministerGroup(requestor)
  }

  /**
   * Validate that the requestor has enough permissions to remove a membership.
   *
   * Returns:
   * - true if the requestor has enough permissions to remove a membership, false otherwise
   */
  canRemoveMembership(requestor: User): boolean {
    return this.canAdministerGroup(requestor)
  }

  private canAdministerGroup(requestor: User): boolean {
    return (
      requestor.orgRole === "admin" ||
      this.isEntityInMembershipWithRole(requestor.id, [HumanGroupMembershipRole.OWNER, HumanGroupMembershipRole.ADMIN])
    )
  }

  static createGroupManager(
    group: Group,
    memberships: ReadonlyArray<Membership>
  ): Either<GroupManagerValidationError, GroupManager> {
    // Validate that an entity does not appear twice in the memberships
    const uniqueEntities = new Set(memberships.map(m => m.getEntityId()))

    if (uniqueEntities.size !== memberships.length) {
      return left("membership_duplicated_membership")
    }

    return right(new GroupManager(group, memberships))
  }
}
