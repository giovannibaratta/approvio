import {Group, User} from "@domain"
import {getStringAsEnum, isUUIDv4} from "@utils"
import * as A from "fp-ts/Array"
import {Applicative, Either, isLeft, left, right} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"

export enum HumanGroupMembershipRole {
  ADMIN = "admin",
  APPROVER = "approver",
  AUDITOR = "auditor",
  OWNER = "owner"
}

export type Membership = Readonly<PrivateMembership>

type UserReference = string
type RoleValidationError = "invalid_role"
export type MembershipValidationError = RoleValidationError | UserValidationReferenceError | "inconsistent_dates"
type UserValidationReferenceError = "invalid_uuid"

interface PrivateMembership {
  entity: User | UserReference
  role: HumanGroupMembershipRole
  createdAt: Date
  updatedAt: Date

  getEntityId(): string
}

function validateRole(role: string): Either<RoleValidationError, HumanGroupMembershipRole> {
  const enumRole = getStringAsEnum(role, HumanGroupMembershipRole)
  if (enumRole === undefined) return left("invalid_role")
  return right(enumRole)
}

function validateUserReference(
  userReference: string | User
): Either<UserValidationReferenceError, UserReference | User> {
  if (typeof userReference === "string" && !isUUIDv4(userReference)) return left("invalid_uuid")
  return right(userReference)
}

export class MembershipFactory {
  static validate(
    data: Parameters<typeof MembershipFactory.semanticValidation>[0]
  ): Either<MembershipValidationError, Membership> {
    return MembershipFactory.semanticValidation(data)
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
    if (data.createdAt > data.updatedAt) return left("inconsistent_dates")

    return right({
      entity: userValidation.right,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      role: roleValidation.right,
      getEntityId: () => getEntityId(userValidation.right)
    })
  }
}

function getEntityId(entity: PrivateMembership["entity"]): string {
  return typeof entity === "string" ? entity : entity.id
}

export type GroupManagerValidationError = "duplicated_membership"
export type RemoveMembershipError = "membership_not_found"
export type UpdateMembershipError = RemoveMembershipError

export class GroupManager {
  private readonly memberships: Map<string, Membership> = new Map()

  private constructor(
    readonly group: Group,
    memberships: ReadonlyArray<Membership>
  ) {
    memberships.forEach(m => this.memberships.set(m.getEntityId(), m))
  }

  getMemberships(): ReadonlyArray<Membership> {
    return Array.from(this.memberships.values())
  }

  addMembership(membershipToAdd: Membership): Either<GroupManagerValidationError, GroupManager> {
    const entityId = membershipToAdd.getEntityId()
    if (this.isEntityInMembership(entityId)) return left("duplicated_membership")

    this.memberships.set(entityId, membershipToAdd)
    return right(this)
  }

  addMemberships(membershipsToAdd: ReadonlyArray<Membership>): Either<GroupManagerValidationError, GroupManager> {
    const result = pipe([...membershipsToAdd], A.traverse(Applicative)(this.addMembership))
    if (isLeft(result)) return result
    return right(this)
  }

  isEntityInMembership(entityId: string): boolean {
    return this.memberships.has(entityId)
  }

  isEntityInMembershipWithRole(entityId: string, role: HumanGroupMembershipRole | HumanGroupMembershipRole[]): boolean {
    const membership = this.memberships.get(entityId)
    const admissibleRoles = Array.isArray(role) ? role : [role]
    return membership !== undefined && admissibleRoles.includes(membership.role)
  }

  removeMembership(entityId: string): Either<RemoveMembershipError, GroupManager> {
    if (!this.isEntityInMembership(entityId)) return left("membership_not_found")

    this.memberships.delete(entityId)
    return right(this)
  }

  updateMembership(membership: Membership): Either<UpdateMembershipError, GroupManager> {
    const eitherRemove = this.removeMembership(membership.getEntityId())
    if (isLeft(eitherRemove)) return eitherRemove
    const eitherAdd = this.addMembership(membership)
    if (isLeft(eitherAdd)) throw new Error("Unexpected error: membership should have been added successfully")
    return right(this)
  }

  canUpdateMembership(requestor: User): boolean {
    return this.canAdministerGroup(requestor)
  }

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
      return left("duplicated_membership")
    }

    return right(new GroupManager(group, memberships))
  }
}
