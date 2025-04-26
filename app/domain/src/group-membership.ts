import {Group, User} from "@domain"
import {isUUID} from "class-validator"
import * as A from "fp-ts/Array"
import {Applicative, Either, isLeft, left, right} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"

export enum HumandGroupMembershipRole {
  ADMIN = "admin",
  APPROVER = "approver",
  AUDITOR = "auditor",
  OWNER = "owner"
}

export type Membership = Readonly<PrivateMembership>

type UserReference = string
type RoleValidationError = "invalid_role"
export type MembershipValidationError = RoleValidationError | UserValidationReferenceError
type UserValidationReferenceError = "invalid_uuid"

interface PrivateMembership {
  entity: User | UserReference
  role: HumandGroupMembershipRole
  createdAt: Date
  updatedAt: Date

  getEntityId(): string
}

function validateRole(role: string): Either<RoleValidationError, HumandGroupMembershipRole> {
  const enumRole = getStringAsEnumMember(role, HumandGroupMembershipRole)
  if (enumRole === undefined) return left("invalid_role")
  return right(enumRole)
}

function validateUserReference(userReference: string): Either<UserValidationReferenceError, UserReference> {
  if (!isUUID(userReference, 4)) return left("invalid_uuid")
  return right(userReference)
}

export class MembershipFactory {
  static validate(data: {user: string; role: string}): Either<MembershipValidationError, Membership> {
    return MembershipFactory.createMembership(data)
  }

  static newMembership(data: {user: string; role: string}): Either<MembershipValidationError, Membership> {
    return MembershipFactory.validate(data)
  }

  private static createMembership(data: {user: string; role: string}): Either<MembershipValidationError, Membership> {
    const roleValidation = validateRole(data.role)
    const userValidation = validateUserReference(data.user)

    if (isLeft(roleValidation)) return left(roleValidation.left)
    if (isLeft(userValidation)) return left(userValidation.left)

    return right({
      entity: userValidation.right,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: roleValidation.right,
      getEntityId: () => getEntityId(userValidation.right)
    })
  }
}

function getEntityId(entity: PrivateMembership["entity"]): string {
  return typeof entity === "string" ? entity : entity.id
}

export type GroupManagerValidationError = "duplicated_membership"
export type RemoveMemebershipError = "membership_not_found"
export type UpdateMembershipError = RemoveMemebershipError

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

  removeMembership(entityId: string): Either<RemoveMemebershipError, GroupManager> {
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

function getStringAsEnumMember<T extends Record<string, string>>(str: string, enumType: T): T[keyof T] | undefined {
  const enumValues = Object.values(enumType)

  if (enumValues.includes(str)) {
    // If it does, we can safely cast the string back to the enum type.
    // This cast is safe because we've just verified the string is one of the enum's values.
    return str as T[keyof T]
  }

  return undefined
}
