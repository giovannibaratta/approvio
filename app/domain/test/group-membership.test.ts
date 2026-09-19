import {
  Group,
  GroupFactory,
  GroupManager,
  Membership,
  MembershipFactory,
  OrgRole,
  User,
  createUserMembershipEntity
} from "@domain"
import {SystemRole} from "../src/system-role"
// TODO: Can we import it via @test ?
import {createTestUser} from "../../test/user"

import {Either, isLeft, isRight} from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"

const organizationId = uuidv7()

// Helpers for unwrapping Either in tests
const unwrapRight = <L, R>(either: Either<L, R>): R => {
  if (isLeft(either)) throw new Error(`Failed to unwrap Either right. Either is left: ${String(either.left)}`)
  return either.right
}

describe("MembershipFactory", () => {
  describe("good cases", () => {
    it("should return right with a Membership object for valid user", () => {
      // Given
      const user = unwrapRight(
        createTestUser({organizationId, accountId: uuidv7(), displayName: "test", orgRole: OrgRole.MEMBER})
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
        createTestUser({organizationId, accountId: uuidv7(), displayName: "test", orgRole: OrgRole.MEMBER})
      )
      const now = new Date()
      const earlier = new Date(now.getTime() - 1000)
      const data = {organizationId, entity: createUserMembershipEntity(user), createdAt: now, updatedAt: earlier}

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
  let orgOwner: User
  let groupManagerMembership: Membership
  let memberMembership: Membership

  beforeEach(() => {
    group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Test-Group", description: "Test-Description"}))

    // Create group scope for role assignment
    const groupScope = {type: "group" as const, organizationId, groupId: group.id}

    // Create users with appropriate roles
    groupManager = unwrapRight(
      createTestUser({
        organizationId,
        accountId: uuidv7(),
        displayName: "groupmanager",
        orgRole: OrgRole.MEMBER
      })
    )
    // Add group manager role to groupManager
    groupManager = {
      ...groupManager,
      roles: [SystemRole.createGroupManagerRole(groupScope)]
    }

    member = unwrapRight(
      createTestUser({organizationId, accountId: uuidv7(), displayName: "member", orgRole: OrgRole.MEMBER})
    )

    orgAdmin = unwrapRight(
      createTestUser({organizationId, accountId: uuidv7(), displayName: "orgadmin", orgRole: OrgRole.ADMIN})
    )
    orgOwner = unwrapRight(
      createTestUser({organizationId, accountId: uuidv7(), displayName: "orgowner", orgRole: OrgRole.OWNER})
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

    it("should reject a membership from another organization", () => {
      const manager = unwrapRight(GroupManager.createGroupManager(group, [groupManagerMembership]))
      const foreignUser = unwrapRight(
        createTestUser({
          organizationId: uuidv7(),
          accountId: uuidv7(),
          displayName: "foreign",
          orgRole: OrgRole.MEMBER
        })
      )
      const foreignMembership = unwrapRight(
        MembershipFactory.newMembership({entity: createUserMembershipEntity(foreignUser)})
      )

      expect(manager.addMembership(foreignMembership)).toBeLeftOf("membership_organization_mismatch")
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

    it("should return true for an org owner", () => {
      expect(manager.canUpdateMembership(orgOwner)).toBe(true)
    })

    it("should reject an owner from another organization", () => {
      const foreignOwner = unwrapRight(
        createTestUser({
          organizationId: uuidv7(),
          accountId: uuidv7(),
          displayName: "foreign-owner",
          orgRole: OrgRole.OWNER
        })
      )
      expect(manager.canUpdateMembership(foreignOwner)).toBe(false)
    })

    it("should return true for a user with group manage permission", () => {
      expect(manager.canUpdateMembership(groupManager)).toBe(true)
    })

    it("should return false for a regular member", () => {
      expect(manager.canUpdateMembership(member)).toBe(false)
    })
  })
})
