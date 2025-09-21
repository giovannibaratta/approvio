import {randomUUID} from "crypto"
import {
  UnconstrainedBoundRole,
  GroupPermission,
  SpacePermission,
  WorkflowTemplatePermission,
  GroupScope,
  SpaceScope,
  WorkflowTemplateScope,
  OrgScope
} from "../src/role"
import {RolePermissionChecker} from "../src/permission-checker"

// Test helper functions
const createOrgScope = (): OrgScope => ({
  type: "org"
})

const createSpaceScope = (spaceId: string = randomUUID()): SpaceScope => ({
  type: "space",
  spaceId
})

const createGroupScope = (groupId: string = randomUUID()): GroupScope => ({
  type: "group",
  groupId
})

const createWorkflowTemplateScope = (workflowTemplateId: string = randomUUID()): WorkflowTemplateScope => ({
  type: "workflow_template",
  workflowTemplateId
})

const createGroupRole = (permissions: GroupPermission[], scope: GroupScope): UnconstrainedBoundRole => ({
  name: "TestGroupRole",
  resourceType: "group",
  permissions,
  scopeType: "group",
  scope
})

const createSpaceRole = (permissions: SpacePermission[], scope: SpaceScope | OrgScope): UnconstrainedBoundRole => ({
  name: "TestSpaceRole",
  resourceType: "space",
  permissions,
  scopeType: "space",
  scope
})

const createOrgRole = (permissions: GroupPermission[], scope: OrgScope): UnconstrainedBoundRole => ({
  name: "TestOrgRole",
  resourceType: "group",
  permissions,
  scopeType: "org",
  scope
})

const createWorkflowTemplateRole = (
  permissions: WorkflowTemplatePermission[],
  scope: WorkflowTemplateScope | SpaceScope | OrgScope
): UnconstrainedBoundRole => ({
  name: "TestWorkflowTemplateRole",
  resourceType: "workflow_template",
  permissions,
  scopeType: "workflow_template",
  scope
})

const createWorkflowRole = (
  permissions: WorkflowTemplatePermission[],
  scope: WorkflowTemplateScope | SpaceScope | OrgScope
): UnconstrainedBoundRole => ({
  name: "TestWorkflowRole",
  resourceType: "workflow_template",
  permissions,
  scopeType: "workflow_template",
  scope
})

describe("RolePermissionChecker", () => {
  const testSpaceId = randomUUID()
  const testGroupId = randomUUID()
  const testWorkflowTemplateId = randomUUID()
  const otherSpaceId = randomUUID()
  const otherGroupId = randomUUID()
  const otherWorkflowTemplateId = randomUUID()

  describe("Group Permission Checking", () => {
    describe("good cases", () => {
      it("should grant access when org-level role has required group permission", () => {
        // Given: org-level role with read permission
        const orgRole = createOrgRole(["read"], createOrgScope())
        const groupScope = createGroupScope(testGroupId)

        // When: checking for read permission on specific group
        const hasPermission = RolePermissionChecker.hasGroupPermission([orgRole], groupScope, "read")

        // Expect: access granted due to org-level hierarchy
        expect(hasPermission).toBe(true)
      })

      it("should grant access when group-level role matches exact scope and has permission", () => {
        // Given: group-level role with write permission for specific group
        const groupRole = createGroupRole(["read", "write"], createGroupScope(testGroupId))
        const groupScope = createGroupScope(testGroupId)

        // When: checking for write permission on same group
        const hasPermission = RolePermissionChecker.hasGroupPermission([groupRole], groupScope, "write")

        // Expect: access granted due to exact scope match
        expect(hasPermission).toBe(true)
      })

      it("should grant access when user has multiple roles and one has required permission", () => {
        // Given: multiple roles, only one with required permission
        const roleWithoutPermission = createGroupRole(["read"], createGroupScope(otherGroupId))
        const roleWithPermission = createGroupRole(["read", "write"], createGroupScope(testGroupId))
        const groupScope = createGroupScope(testGroupId)

        // When: checking for write permission
        const hasPermission = RolePermissionChecker.hasGroupPermission(
          [roleWithoutPermission, roleWithPermission],
          groupScope,
          "write"
        )

        // Expect: access granted due to second role
        expect(hasPermission).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("should deny access when no roles provided", () => {
        // Given: empty roles array
        const groupScope = createGroupScope(testGroupId)

        // When: checking for any permission
        const hasPermission = RolePermissionChecker.hasGroupPermission([], groupScope, "read")

        // Expect: access denied
        expect(hasPermission).toBe(false)
      })

      it("should deny access when role has permission but wrong scope", () => {
        // Given: group role for different group
        const groupRole = createGroupRole(["read", "write", "manage"], createGroupScope(otherGroupId))
        const groupScope = createGroupScope(testGroupId)

        // When: checking permission on different group
        const hasPermission = RolePermissionChecker.hasGroupPermission([groupRole], groupScope, "write")

        // Expect: access denied due to scope mismatch
        expect(hasPermission).toBe(false)
      })

      it("should deny access when role has correct scope but missing permission", () => {
        // Given: group role with only read permission
        const groupRole = createGroupRole(["read"], createGroupScope(testGroupId))
        const groupScope = createGroupScope(testGroupId)

        // When: checking for write permission
        const hasPermission = RolePermissionChecker.hasGroupPermission([groupRole], groupScope, "write")

        // Expect: access denied due to missing permission
        expect(hasPermission).toBe(false)
      })
    })
  })

  describe("Space Permission Checking", () => {
    describe("good cases", () => {
      it("should grant access when org-level role has required space permission", () => {
        // Given: org-level role with manage permission
        const orgRole = createSpaceRole(["read", "manage"], createOrgScope())
        const spaceScope = createSpaceScope(testSpaceId)

        // When: checking for manage permission
        const hasPermission = RolePermissionChecker.hasSpacePermission([orgRole], spaceScope, "manage")

        // Expect: access granted due to org-level hierarchy
        expect(hasPermission).toBe(true)
      })

      it("should grant access when space-level role matches exact scope", () => {
        // Given: space-level role for specific space
        const spaceRole = createSpaceRole(["read"], createSpaceScope(testSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When: checking for read permission on same space
        const hasPermission = RolePermissionChecker.hasSpacePermission([spaceRole], spaceScope, "read")

        // Expect: access granted due to exact scope match
        expect(hasPermission).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("should deny access when space role has different space id", () => {
        // Given: space role for different space
        const spaceRole = createSpaceRole(["read", "manage"], createSpaceScope(otherSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When: checking permission on different space
        const hasPermission = RolePermissionChecker.hasSpacePermission([spaceRole], spaceScope, "read")

        // Expect: access denied due to space ID mismatch
        expect(hasPermission).toBe(false)
      })
    })
  })

  describe("Workflow Template Permission Checking", () => {
    describe("good cases", () => {
      it("should grant access for all workflow template permissions with org-level role", () => {
        // Given: org-level role with all workflow template permissions
        const orgRole = createWorkflowTemplateRole(["read", "write", "instantiate", "vote"], createOrgScope())
        const spaceScope = createSpaceScope(testSpaceId)

        // When & Expect: all permissions should be granted
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "write")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "instantiate")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "vote")).toBe(true)
      })

      it("should grant specific workflow template permissions", () => {
        // Given: space role with specific permissions
        const spaceRole = createWorkflowTemplateRole(["read", "instantiate"], createSpaceScope(testSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When & Expect: only granted permissions should work
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "instantiate")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "write")).toBe(false)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "vote")).toBe(false)
      })
    })

    describe("bad cases", () => {
      it("should deny access when role lacks specific workflow template permission", () => {
        // Given: role with only read permission
        const role = createWorkflowTemplateRole(["read"], createSpaceScope(testSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When: checking for write permission
        const hasPermission = RolePermissionChecker.hasWorkflowTemplatePermission([role], spaceScope, "write")

        // Expect: access denied
        expect(hasPermission).toBe(false)
      })
    })
  })

  describe("Workflow Permission Checking", () => {
    describe("good cases", () => {
      it("should grant access for all workflow permissions with org-level role", () => {
        // Given: org-level role with all workflow permissions
        const orgRole = createWorkflowRole(["workflow_read", "workflow_list", "workflow_cancel"], createOrgScope())
        const spaceScope = createSpaceScope(testSpaceId)

        // When & Expect: all permissions should be granted
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "workflow_read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "workflow_list")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "workflow_cancel")).toBe(true)
      })

      it("should grant specific workflow permissions", () => {
        // Given: space role with specific permissions
        const spaceRole = createWorkflowRole(["workflow_read", "workflow_list"], createSpaceScope(testSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When & Expect: only granted permissions should work
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "workflow_read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "workflow_list")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([spaceRole], spaceScope, "workflow_cancel")).toBe(
          false
        )
      })
    })

    describe("bad cases", () => {
      it("should deny access when role lacks specific workflow permission", () => {
        // Given: role with only read permission
        const role = createWorkflowRole(["workflow_read"], createSpaceScope(testSpaceId))
        const spaceScope = createSpaceScope(testSpaceId)

        // When: checking for cancel permission
        const hasPermission = RolePermissionChecker.hasWorkflowTemplatePermission([role], spaceScope, "workflow_cancel")

        // Expect: access denied
        expect(hasPermission).toBe(false)
      })
    })
  })

  describe("Workflow Template Resource Scope Permission Checking", () => {
    describe("good cases", () => {
      it("should grant access when org-level role has required workflow template permission for any template", () => {
        // Given: org-level role with workflow template permissions
        const orgRole = createWorkflowTemplateRole(["read", "write", "instantiate", "vote"], createOrgScope())
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When & Expect: all permissions should be granted for any template
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], templateScope, "read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], templateScope, "write")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], templateScope, "instantiate")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], templateScope, "vote")).toBe(true)
      })

      it("should grant access when template-scoped role matches exact template ID", () => {
        // Given: template-scoped role for specific template
        const templateRole = createWorkflowTemplateRole(
          ["read", "instantiate"],
          createWorkflowTemplateScope(testWorkflowTemplateId)
        )
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When & Expect: permissions should be granted for exact template match
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], templateScope, "read")).toBe(true)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], templateScope, "instantiate")).toBe(
          true
        )
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], templateScope, "write")).toBe(false)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], templateScope, "vote")).toBe(false)
      })

      it("should grant access when user has multiple template roles and one matches", () => {
        // Given: multiple template roles, only one for the requested template
        const otherTemplateRole = createWorkflowTemplateRole(
          ["read"],
          createWorkflowTemplateScope(otherWorkflowTemplateId)
        )
        const targetTemplateRole = createWorkflowTemplateRole(
          ["read", "vote"],
          createWorkflowTemplateScope(testWorkflowTemplateId)
        )
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When: checking permission on target template
        const hasPermission = RolePermissionChecker.hasWorkflowTemplatePermission(
          [otherTemplateRole, targetTemplateRole],
          templateScope,
          "vote"
        )

        // Expect: access granted due to matching role
        expect(hasPermission).toBe(true)
      })
    })

    describe("bad cases", () => {
      it("should deny access when template role has different template ID", () => {
        // Given: template role for different template
        const templateRole = createWorkflowTemplateRole(
          ["read", "write", "instantiate", "vote"],
          createWorkflowTemplateScope(otherWorkflowTemplateId)
        )
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When: checking permission on different template
        const hasPermission = RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], templateScope, "read")

        // Expect: access denied due to template ID mismatch
        expect(hasPermission).toBe(false)
      })

      it("should deny access when template role lacks required permission", () => {
        // Given: template role with limited permissions
        const templateRole = createWorkflowTemplateRole(["read"], createWorkflowTemplateScope(testWorkflowTemplateId))
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When: checking for permission not granted to the role
        const hasPermission = RolePermissionChecker.hasWorkflowTemplatePermission(
          [templateRole],
          templateScope,
          "write"
        )

        // Expect: access denied due to missing permission
        expect(hasPermission).toBe(false)
      })
    })
  })

  describe("Scope Hierarchy and Cross-Resource Access", () => {
    describe("good cases", () => {
      it("should allow org-level permissions to work across all resource types", () => {
        // Given: org-level roles for different permission types
        const orgGroupRole = createOrgRole(["read", "write", "manage"], createOrgScope())
        const orgSpaceRole = createSpaceRole(["read", "manage"], createOrgScope())
        const orgWorkflowTemplateRole = createWorkflowTemplateRole(
          ["read", "write", "instantiate", "vote"],
          createOrgScope()
        )
        const orgWorkflowRole = createWorkflowRole(
          ["workflow_read", "workflow_list", "workflow_cancel"],
          createOrgScope()
        )

        const anySpaceScope = createSpaceScope(testSpaceId)
        const anyGroupScope = createGroupScope(testGroupId)
        const anyTemplateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When & Expect: org roles should work for any scope
        expect(RolePermissionChecker.hasGroupPermission([orgGroupRole], anyGroupScope, "manage")).toBe(true)
        expect(RolePermissionChecker.hasGroupPermission([orgGroupRole], anyGroupScope, "write")).toBe(true)
        expect(RolePermissionChecker.hasSpacePermission([orgSpaceRole], anySpaceScope, "manage")).toBe(true)
        expect(
          RolePermissionChecker.hasWorkflowTemplatePermission([orgWorkflowTemplateRole], anySpaceScope, "vote")
        ).toBe(true)
        expect(
          RolePermissionChecker.hasWorkflowTemplatePermission(
            [orgWorkflowTemplateRole],
            anyTemplateScope,
            "instantiate"
          )
        ).toBe(true)
        expect(
          RolePermissionChecker.hasWorkflowTemplatePermission([orgWorkflowRole], anySpaceScope, "workflow_cancel")
        ).toBe(true)
      })

      it("should handle complex multi-role scenarios", () => {
        // Given: user with multiple roles across different scopes
        const orgRole = createOrgRole(["read"], createOrgScope())
        const spaceRole = createSpaceRole(["read"], createSpaceScope(testSpaceId))
        const groupRole = createGroupRole(["manage"], createGroupScope(testGroupId))

        const spaceScope = createSpaceScope(testSpaceId)
        const groupScope = createGroupScope(testGroupId)

        // When & Expect: should get highest available permission from any role
        expect(RolePermissionChecker.hasGroupPermission([orgRole, spaceRole, groupRole], groupScope, "read")).toBe(true) // org role
        expect(RolePermissionChecker.hasSpacePermission([orgRole, spaceRole, groupRole], spaceScope, "read")).toBe(true) // space role
        expect(RolePermissionChecker.hasGroupPermission([orgRole, spaceRole, groupRole], groupScope, "manage")).toBe(
          true
        ) // group role
        expect(RolePermissionChecker.hasGroupPermission([orgRole, spaceRole, groupRole], groupScope, "read")).toBe(true) // org role applies everywhere
      })

      it("should handle mixed resource-specific and general scope roles", () => {
        // Given: user with mix of resource-specific and general roles
        const orgRole = createWorkflowRole(["read"], createOrgScope())
        const templateSpecificRole = createWorkflowTemplateRole(
          ["read", "vote"],
          createWorkflowTemplateScope(testWorkflowTemplateId)
        )
        const groupRole = createGroupRole(["read", "write"], createGroupScope(testGroupId))

        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)
        const groupScope = createGroupScope(testGroupId)
        const spaceScope = createSpaceScope(testSpaceId)

        // When & Expect: specific roles work for exact resources, org role works everywhere
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([orgRole], spaceScope, "read")).toBe(true) // org role works everywhere
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([templateSpecificRole], templateScope, "vote")).toBe(
          true
        ) // specific role
        expect(RolePermissionChecker.hasGroupPermission([groupRole], groupScope, "write")).toBe(true) // group role

        // Cross-resource access should be denied for specific roles
        expect(
          RolePermissionChecker.hasWorkflowTemplatePermission(
            [templateSpecificRole],
            createWorkflowTemplateScope(otherWorkflowTemplateId),
            "vote"
          )
        ).toBe(false)
      })
    })

    describe("bad cases", () => {
      it("should deny access when no role matches the requested scope", () => {
        // Given: roles for specific scopes
        const spaceRole = createSpaceRole(["read", "manage"], createSpaceScope(testSpaceId))
        const groupRole = createGroupRole(["read", "write"], createGroupScope(testGroupId))
        const templateRole = createWorkflowTemplateRole(
          ["read", "vote"],
          createWorkflowTemplateScope(testWorkflowTemplateId)
        )

        const differentSpaceScope = createSpaceScope(otherSpaceId)
        const differentGroupScope = createGroupScope(otherGroupId)
        const differentTemplateScope = createWorkflowTemplateScope(otherWorkflowTemplateId)

        // When & Expect: access denied for different scopes
        expect(RolePermissionChecker.hasSpacePermission([spaceRole], differentSpaceScope, "read")).toBe(false)
        expect(RolePermissionChecker.hasGroupPermission([groupRole], differentGroupScope, "read")).toBe(false)
        expect(
          RolePermissionChecker.hasWorkflowTemplatePermission([templateRole], differentTemplateScope, "read")
        ).toBe(false)
      })

      it("should deny access when roles have empty permissions", () => {
        // Given: roles with no permissions
        const emptyGroupRole = createGroupRole([], createGroupScope(testGroupId))
        const emptySpaceRole = createSpaceRole([], createSpaceScope(testSpaceId))
        const emptyTemplateRole = createWorkflowTemplateRole([], createWorkflowTemplateScope(testWorkflowTemplateId))

        const groupScope = createGroupScope(testGroupId)
        const spaceScope = createSpaceScope(testSpaceId)
        const templateScope = createWorkflowTemplateScope(testWorkflowTemplateId)

        // When & Expect: access denied despite scope match
        expect(RolePermissionChecker.hasGroupPermission([emptyGroupRole], groupScope, "read")).toBe(false)
        expect(RolePermissionChecker.hasSpacePermission([emptySpaceRole], spaceScope, "read")).toBe(false)
        expect(RolePermissionChecker.hasWorkflowTemplatePermission([emptyTemplateRole], templateScope, "read")).toBe(
          false
        )
      })
    })
  })
})
