import {
  Group,
  GroupFactory,
  GroupManager,
  HumanGroupMembershipRole,
  Membership,
  MembershipFactory,
  MembershipValidationError,
  OrgRole,
  User,
  UserFactory
} from "@domain"
import {randomUUID} from "crypto"

import {Either, isLeft, isRight} from "fp-ts/lib/Either"

// Helpers for unwrapping Either in tests
const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${either.left}`)
  return either.right
}

const unwrapLeft = <L, R>(either: Either<L, R>): L => {
  if (isRight(either)) throw new Error(`Failed to unwrap Either left: Either is right ${either.right}`)
  return either.left
}

describe("MembershipFactory", () => {
  describe("good cases", () => {
    it("should return right with a Membership object for valid user and role", () => {
      // Given
      const data = {user: randomUUID(), role: HumanGroupMembershipRole.ADMIN.toString()}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isRight(result)).toBe(true)
      const membership = unwrapRight(result)
      expect(membership.entity).toBe(data.user)
      expect(membership.role).toBe(HumanGroupMembershipRole.ADMIN)
      expect(membership.createdAt).toBeInstanceOf(Date)
      expect(membership.updatedAt).toBeInstanceOf(Date)
      expect(membership.getEntityId()).toBe(data.user)
    })
  })

  describe("bad cases", () => {
    it("should return left with 'membership_invalid_uuid' for an invalid user string", () => {
      // Given
      const data = {user: "invalid-uuid", role: HumanGroupMembershipRole.ADMIN.toString()}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<MembershipValidationError>("membership_invalid_user_uuid")
    })

    it("should return left with 'membership_invalid_role' for an invalid role string", () => {
      // Given
      const data = {user: randomUUID(), role: "invalid_role_string"}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isLeft(result)).toBe(true)
      expect(unwrapLeft(result)).toBe<MembershipValidationError>("membership_invalid_role")
    })

    it("should return an error when user reference is not a valid UUID", () => {
      // Given: user reference is not a valid UUID
      const data = {entity: "invalid-uuid", role: "admin", createdAt: new Date(), updatedAt: new Date()}

      // When
      const result = MembershipFactory.validate(data)

      // Expect
      expect(result).toBeLeftOf("membership_invalid_user_uuid")
    })

    it("should return an error when role is not valid", () => {
      // Given: role is not valid
      const data = {entity: randomUUID(), role: "invalid", createdAt: new Date(), updatedAt: new Date()}

      // When
      const result = MembershipFactory.validate(data)

      // Expect
      expect(result).toBeLeftOf("membership_invalid_role")
    })
  })
})

describe("GroupManager", () => {
  let group: Group
  let owner: User
  let member: User
  let admin: User
  let orgAdmin: User
  let ownerMembership: Membership
  let memberMembership: Membership
  let adminMembership: Membership

  beforeEach(() => {
    group = unwrapRight(GroupFactory.newGroup({name: "Test-Group", description: "Test-Description"}))
    owner = unwrapRight(UserFactory.newUser({displayName: "owner", email: "owner@test.com", orgRole: OrgRole.MEMBER}))
    member = unwrapRight(
      UserFactory.newUser({displayName: "member", email: "member@test.com", orgRole: OrgRole.MEMBER})
    )
    admin = unwrapRight(UserFactory.newUser({displayName: "admin", email: "admin@test.com", orgRole: OrgRole.MEMBER}))
    orgAdmin = unwrapRight(
      UserFactory.newUser({displayName: "orgadmin", email: "orgadmin@test.com", orgRole: OrgRole.ADMIN})
    )

    ownerMembership = unwrapRight(
      MembershipFactory.newMembership({
        user: owner.id,
        role: "owner"
      })
    )
    memberMembership = unwrapRight(
      MembershipFactory.newMembership({
        user: member.id,
        role: "approver"
      })
    )
    adminMembership = unwrapRight(
      MembershipFactory.newMembership({
        user: admin.id,
        role: "admin"
      })
    )
  })

  describe("createGroupManager", () => {
    it("should create a group manager successfully", () => {
      const result = GroupManager.createGroupManager(group, [ownerMembership])
      expect(result).toBeRight()
    })

    it("should fail with duplicated membership error when creating group manager with duplicate entities", () => {
      // Given
      const duplicateMembership = unwrapRight(
        MembershipFactory.newMembership({
          user: owner.id,
          role: "owner"
        })
      )
      const memberships = [duplicateMembership, duplicateMembership]

      // When
      const result = GroupManager.createGroupManager(group, memberships)

      // Expect
      expect(result).toBeLeftOf("membership_duplicated_membership")
    })
  })

  describe("addMembership", () => {
    it("should fail to add a duplicate membership", () => {
      // Given: a group manager with existing memberships
      const manager = unwrapRight(GroupManager.createGroupManager(group, [ownerMembership]))

      // When: trying to add the same membership again
      const result = manager.addMembership(ownerMembership)

      // Expect
      expect(result).toBeLeftOf("membership_entity_already_in_group")
    })
  })

  describe("removeMembership", () => {
    it("should fail to remove a non-existent membership", () => {
      const manager = unwrapRight(GroupManager.createGroupManager(group, [ownerMembership]))
      const result = manager.removeMembership(member.id)
      expect(result).toBeLeftOf("membership_not_found")
    })

    it("should fail to remove the last owner", () => {
      const manager = unwrapRight(GroupManager.createGroupManager(group, [ownerMembership]))
      const result = manager.removeMembership(owner.id)
      expect(result).toBeLeftOf("membership_no_owner")
    })
  })

  describe("canAdministerGroup", () => {
    let manager: GroupManager

    beforeEach(() => {
      manager = unwrapRight(
        GroupManager.createGroupManager(group, [ownerMembership, adminMembership, memberMembership])
      )
    })

    it("should return true for an org admin", () => {
      expect(manager.canUpdateMembership(orgAdmin)).toBe(true)
    })

    it("should return true for a group owner", () => {
      expect(manager.canUpdateMembership(owner)).toBe(true)
    })

    it("should return true for a group admin", () => {
      expect(manager.canUpdateMembership(admin)).toBe(true)
    })

    it("should return false for a regular member", () => {
      expect(manager.canUpdateMembership(member)).toBe(false)
    })
  })
})
