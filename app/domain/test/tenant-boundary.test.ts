import {randomOrgId} from "@test/organization-id"
import {v7 as uuidv7} from "uuid"
import {
  MembershipStatus,
  OrganizationFactory,
  OrgRole,
  RolePermissionChecker,
  RoleAuthorizationChecker,
  SystemRole,
  User,
  UserFactory
} from "@domain"
import {unwrapRight} from "@utils/either"
import {createTestUser} from "@test/user"

const createUser = (organizationId: string, orgRole: OrgRole): User =>
  unwrapRight(
    createTestUser({
      organizationId,
      accountId: uuidv7(),
      displayName: "Test User",
      orgRole
    })
  )

describe("tenant domain boundary", () => {
  it("initializes a validated local membership in the domain", () => {
    // Given
    const organizationId = randomOrgId()
    const accountId = uuidv7()

    // When
    const membership = unwrapRight(
      UserFactory.create({organizationId, accountId, displayName: "Member", orgRole: OrgRole.MEMBER})
    )

    // Expect
    expect(membership).toMatchObject({
      organizationId,
      accountId,
      status: MembershipStatus.ACTIVE,
      orgRole: OrgRole.MEMBER,
      roles: []
    })
    expect(membership.updatedAt).toEqual(membership.createdAt)
    expect(
      UserFactory.create({organizationId, accountId: "invalid", displayName: "Member", orgRole: OrgRole.MEMBER})
    ).toBeLeftOf("user_invalid_account_id")
  })

  it("resets the organization role and local grants on removal", () => {
    // Given
    const organizationId = randomOrgId()
    const owner = createUser(organizationId, OrgRole.OWNER)
    const granted = unwrapRight(
      UserFactory.assignRoles(owner, [
        SystemRole.createGroupManagerRole({type: "group", organizationId, groupId: uuidv7()})
      ])
    )

    // When
    const removed = unwrapRight(UserFactory.remove(granted))

    // Expect
    expect(removed).toMatchObject({id: owner.id, status: MembershipStatus.REMOVED, orgRole: OrgRole.MEMBER, roles: []})
    expect(UserFactory.changeOrgRole(removed, OrgRole.OWNER)).toBeLeftOf("user_invalid_membership_transition")
    expect(UserFactory.remove(removed)).toBeLeftOf("user_invalid_membership_transition")
  })

  it("changes the organization role without changing membership identity or local grants", () => {
    // Given
    const user = createUser(randomOrgId(), OrgRole.MEMBER)

    // When
    const promoted = unwrapRight(UserFactory.changeOrgRole(user, OrgRole.ADMIN))

    // Expect
    expect(promoted).toMatchObject({
      id: user.id,
      accountId: user.accountId,
      organizationId: user.organizationId,
      orgRole: OrgRole.ADMIN,
      roles: user.roles
    })
    expect(promoted.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime())
    expect(user.orgRole).toBe(OrgRole.MEMBER)
  })

  it("does not match a role from another organization even when the resource id matches", () => {
    // Given
    const organizationA = randomOrgId()
    const organizationB = randomOrgId()
    const groupId = uuidv7()
    const role = SystemRole.createGroupManagerRole({type: "group", organizationId: organizationA, groupId})
    const user = createUser(organizationB, OrgRole.MEMBER)
    const admin = createUser(organizationB, OrgRole.ADMIN)
    const owner = createUser(organizationB, OrgRole.OWNER)
    const targetGroup = {type: "group" as const, organizationId: organizationB, groupId}

    // When
    const assignment = UserFactory.assignRoles(user, [role])
    const hasPermission = RolePermissionChecker.hasGroupPermission([role], targetGroup, "manage")
    const adminCanAssign = RoleAuthorizationChecker.canAssignRoles(admin, [role])
    const ownerCanAssign = RoleAuthorizationChecker.canAssignRoles(owner, [role])

    // Expect
    expect(assignment).toBeLeftOf("user_role_organization_mismatch")
    expect(hasPermission).toBe(false)
    expect(adminCanAssign).toBe(false)
    expect(ownerCanAssign).toBe(false)
  })

  it("clears local grants when a removed member is readmitted", () => {
    // Given
    const organizationId = randomOrgId()
    const groupId = uuidv7()
    const user = createUser(organizationId, OrgRole.MEMBER)
    const role = SystemRole.createGroupManagerRole({type: "group", organizationId, groupId})
    const assigned = unwrapRight(UserFactory.assignRoles(user, [role]))
    const removed = unwrapRight(UserFactory.remove(assigned))

    // When
    const readmitted = unwrapRight(UserFactory.readmit(removed, OrgRole.MEMBER))

    // Expect
    expect(removed.status).toBe(MembershipStatus.REMOVED)
    expect(readmitted.status).toBe(MembershipStatus.ACTIVE)
    expect(readmitted.roles).toEqual([])
    expect(readmitted.id).toBe(user.id)
  })

  it("rejects a removed member that still has local grants", () => {
    // Given
    const organizationId = randomOrgId()
    const user = createUser(organizationId, OrgRole.MEMBER)
    const role = SystemRole.createGroupManagerRole({type: "group", organizationId, groupId: uuidv7()})
    const removed = unwrapRight(UserFactory.remove(user))
    const removedWithGrants = {...removed, roles: [role]}

    // When
    const result = UserFactory.validate(removedWithGrants)

    // Expect
    expect(result).toBeLeftOf("user_membership_roles_invalid")
  })

  it("prevents admins from creating or changing owners", () => {
    // Given
    const organizationId = randomOrgId()
    const admin = createUser(organizationId, OrgRole.ADMIN)
    const member = createUser(organizationId, OrgRole.MEMBER)
    const owner = createUser(organizationId, OrgRole.OWNER)

    // When
    const canPromoteToOwner = UserFactory.canGrantOrgRole(admin, member, OrgRole.OWNER)
    const canDemoteOwner = UserFactory.canGrantOrgRole(admin, owner, OrgRole.MEMBER)

    // Expect
    expect(canPromoteToOwner).toBe(false)
    expect(canDemoteOwner).toBe(false)
  })

  it("enforces lifecycle transitions and owner resume limits", () => {
    // Given
    const id = uuidv7()
    const now = new Date()
    const organization = unwrapRight(
      OrganizationFactory.validate({
        id,
        organizationId: id,
        slug: "test-org",
        displayName: "Test organization",
        status: "active",
        createdAt: now,
        updatedAt: now
      })
    )
    const suspended = unwrapRight(
      OrganizationFactory.transition(organization, {status: "suspended", reason: "security"}, "operator")
    )

    // When
    const ownerResume = OrganizationFactory.transition(suspended, {status: "active"}, "owner")
    const operatorResume = OrganizationFactory.transition(suspended, {status: "active"}, "operator")

    // Expect
    expect(ownerResume).toBeLeftOf("organization_resume_not_permitted")
    expect(operatorResume).toBeRightOf(expect.objectContaining({status: "active"}))
  })
})
