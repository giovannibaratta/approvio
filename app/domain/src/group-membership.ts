import {Group, User} from "@domain"
import {isUUIDv4, PrefixUnion} from "@utils"
import * as A from "fp-ts/Array"
import {Applicative, Do, Either, isLeft, left, right, chain, bindW} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"
import {RolePermissionChecker} from "./permission-checker"
import {GroupScope} from "./role"

export type Membership = Readonly<PrivateMembership>
export type MembershipWithGroupRef = Readonly<PrivateMembershipWithGroupRef>

type EntityType = "user" | "agent"
export type MembershipValidationError = PrefixUnion<"membership", UnprefixedMembershipValidationError>
export type MembershipValidationErrorWithGroupRef = PrefixUnion<
  "membership",
  UnprefixedMembershipValidationErrorWithGroupRef
>
type EntityValidationReferenceError = "invalid_entity_uuid"
type GroupValidationReferenceError = "invalid_group_uuid"

type UnprefixedMembershipValidationError = EntityValidationReferenceError | "inconsistent_dates"
type UnprefixedMembershipValidationErrorWithGroupRef =
  | UnprefixedMembershipValidationError
  | GroupValidationReferenceError

interface PrivateMembershipWithGroupRef extends PrivateMembership {
  groupId: string
}

interface PrivateMembership {
  entity: User
  createdAt: Date
  updatedAt: Date

  getEntityId(): string
  getEntityType(): EntityType
}

function validateGroupReference(groupReference: string): Either<MembershipValidationErrorWithGroupRef, string> {
  if (!isUUIDv4(groupReference)) return left("membership_invalid_group_uuid")
  return right(groupReference)
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

  static newMembership(data: {entity: User}): Either<MembershipValidationError, Membership> {
    const now = new Date()
    return MembershipFactory.semanticValidation({
      entity: data.entity,
      createdAt: now,
      updatedAt: now
    })
  }

  private static semanticValidation(
    data: Omit<Membership, "getEntityId" | "getEntityType">
  ): Either<MembershipValidationError, Membership> {
    if (data.createdAt > data.updatedAt) return left("membership_inconsistent_dates")

    return right({
      entity: data.entity,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      getEntityId: () => getEntityId(data.entity),
      getEntityType: () => getEntityType(data.entity)
    })
  }
}

function getEntityId(entity: PrivateMembership["entity"]): EntityId {
  return entity.id
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getEntityType(entity: PrivateMembership["entity"]): EntityType {
  // Only users are supported for now
  return "user"
}

export type GroupManagerValidationError = PrefixUnion<"membership", "duplicated_membership">
export type AddMembershipError = PrefixUnion<"membership", "entity_already_in_group">
export type RemoveMembershipError = PrefixUnion<"membership", "not_found" | "no_admin">
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

  removeMembership(entityId: string): Either<RemoveMembershipError, GroupManager> {
    if (!this.isEntityInMembership(entityId)) return left("membership_not_found")

    const membershipToRemove = this.memberships.get(entityId)
    if (membershipToRemove === undefined) return left("membership_not_found")

    // Check if removing this member would leave the group without any administrators
    const user = membershipToRemove.entity
    const groupScope: GroupScope = {
      type: "group",
      groupId: this.group.id
    }

    // If this user has manage permission, check if they're the last admin
    if (RolePermissionChecker.hasGroupPermission(user.roles, groupScope, "manage")) {
      const remainingMemberships = Array.from(this.memberships.values()).filter(m => m.getEntityId() !== entityId)
      const hasOtherAdmins = remainingMemberships.some(membership => {
        const memberUser = membership.entity
        return RolePermissionChecker.hasGroupPermission(memberUser.roles, groupScope, "manage")
      })

      if (!hasOtherAdmins) return left("membership_no_admin")
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
    // Organization admins can administer any group
    if (requestor.orgRole === "admin") return true

    const groupScope: GroupScope = {
      type: "group",
      groupId: this.group.id
    }

    return RolePermissionChecker.hasGroupPermission(requestor.roles, groupScope, "manage")
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
