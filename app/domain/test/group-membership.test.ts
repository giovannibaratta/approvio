import {
  Group,
  GroupFactory,
  GroupManager,
  Membership,
  MembershipFactory,
  OrgRole,
  User,
  UserFactory,
  RoleFactory,
  createUserMembershipEntity
} from "@domain"

import {Either, isLeft, isRight} from "fp-ts/lib/Either"

// Helpers for unwrapping Either in tests
const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${either.left}`)
  return either.right
}

describe("MembershipFactory", () => {
  describe("good cases", () => {
    it("should return right with a Membership object for valid user", () => {
      // Given
      const user = unwrapRight(
        UserFactory.newUser({displayName: "test", email: "test@test.com", orgRole: OrgRole.MEMBER})
      )
      const data = {entity: createUserMembershipEntity(user)}

      // When
      const result = MembershipFactory.newMembership(data)

      // Expect
      expect(isRight(result)).toBe(true)
      const membership = unwrapRight(result)
      expect(membership.entity).toBe(data.entity)
      expect(membership.createdAt).toBeInstanceOf(Date)
      expect(membership.updatedAt).toBeInstanceOf(Date)
      expect(membership.getEntityId()).toBe(user.id)
    })
  })

  describe("bad cases", () => {
    it("should return an error when dates are inconsistent", () => {
      // Given: createdAt is after updatedAt
      const user = unwrapRight(
        UserFactory.newUser({displayName: "test", email: "test@test.com", orgRole: OrgRole.MEMBER})
      )
      const now = new Date()
      const earlier = new Date(now.getTime() - 1000)
      const data = {entity: createUserMembershipEntity(user), createdAt: now, updatedAt: earlier}

      // When
      const result = MembershipFactory.validate(data)

      // Expect
      expect(result).toBeLeftOf("membership_inconsistent_dates")
    })
  })
})

describe("GroupManager", () => {
  let group: Group
  let groupManager: User
  let member: User
  let orgAdmin: User
  let groupManagerMembership: Membership
  let memberMembership: Membership

  beforeEach(() => {
    group = unwrapRight(GroupFactory.newGroup({name: "Test-Group", description: "Test-Description"}))

    // Create group scope for role assignment
    const groupScope = {type: "group" as const, groupId: group.id}

    // Create users with appropriate roles
    groupManager = unwrapRight(
      UserFactory.newUser({displayName: "groupmanager", email: "groupmanager@test.com", orgRole: OrgRole.MEMBER})
    )
    // Add group manager role to groupManager
    groupManager = {
      ...groupManager,
      roles: [RoleFactory.createGroupManagerRole(groupScope)]
    }

    member = unwrapRight(
      UserFactory.newUser({displayName: "member", email: "member@test.com", orgRole: OrgRole.MEMBER})
    )

    orgAdmin = unwrapRight(
      UserFactory.newUser({displayName: "orgadmin", email: "orgadmin@test.com", orgRole: OrgRole.ADMIN})
    )

    groupManagerMembership = unwrapRight(
      MembershipFactory.newMembership({
        entity: createUserMembershipEntity(groupManager)
      })
    )
    memberMembership = unwrapRight(
      MembershipFactory.newMembership({
        entity: createUserMembershipEntity(member)
      })
    )
  })

  describe("createGroupManager", () => {
    it("should create a group manager successfully", () => {
      const result = GroupManager.createGroupManager(group, [groupManagerMembership])
      expect(result).toBeRight()
    })

    it("should fail with duplicated membership error when creating group manager with duplicate entities", () => {
      // Given
      const duplicateMembership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(groupManager)
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
      const manager = unwrapRight(GroupManager.createGroupManager(group, [groupManagerMembership]))

      // When: trying to add the same membership again
      const result = manager.addMembership(groupManagerMembership)

      // Expect
      expect(result).toBeLeftOf("membership_entity_already_in_group")
    })
  })

  describe("removeMembership", () => {
    it("should fail to remove a non-existent membership", () => {
      const manager = unwrapRight(GroupManager.createGroupManager(group, [groupManagerMembership]))
      const result = manager.removeMembership(createUserMembershipEntity(member))
      expect(result).toBeLeftOf("membership_not_found")
    })

    it("should fail to remove the last admin", () => {
      const manager = unwrapRight(GroupManager.createGroupManager(group, [groupManagerMembership]))
      const result = manager.removeMembership(groupManagerMembership.entity)
      expect(result).toBeLeftOf("membership_no_admin")
    })
  })

  describe("canAdministerGroup", () => {
    let manager: GroupManager

    beforeEach(() => {
      manager = unwrapRight(GroupManager.createGroupManager(group, [groupManagerMembership, memberMembership]))
    })

    it("should return true for an org admin", () => {
      expect(manager.canUpdateMembership(orgAdmin)).toBe(true)
    })

    it("should return true for a user with group manage permission", () => {
      expect(manager.canUpdateMembership(groupManager)).toBe(true)
    })

    it("should return false for a regular member", () => {
      expect(manager.canUpdateMembership(member)).toBe(false)
    })
  })
})
