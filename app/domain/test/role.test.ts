import {
  UnconstrainedBoundRole,
  GroupPermission,
  GroupScope,
  OrgScope,
  RoleFactory,
  SpacePermission,
  SpaceScope,
  WorkflowTemplatePermission,
  WorkflowTemplateScope
} from "../src/role"
import {SystemRole} from "../src/system-role"

describe("RoleFactory", () => {
  // Test data helpers
  const createValidOrgScope = (): OrgScope => ({
    type: "org"
  })

  const createValidSpaceScope = (): SpaceScope => ({
    type: "space",
    spaceId: "space-123"
  })

  const createValidGroupScope = (): GroupScope => ({
    type: "group",
    groupId: "group-123"
  })

  const createValidWorkflowTemplateScope = (): WorkflowTemplateScope => ({
    type: "workflow_template",
    workflowTemplateId: "template-123"
  })

  const createValidGroupRole = (permissions: GroupPermission[] = ["read"]): UnconstrainedBoundRole => ({
    name: "TestGroupRole",
    resourceType: "group",
    permissions,
    scope: createValidGroupScope(),
    scopeType: "group"
  })

  const createValidSpaceRole = (permissions: SpacePermission[] = ["read"]): UnconstrainedBoundRole => ({
    name: "TestSpaceRole",
    resourceType: "space",
    permissions,
    scope: createValidSpaceScope(),
    scopeType: "space"
  })

  const createValidWorkflowTemplateRole = (
    permissions: WorkflowTemplatePermission[] = ["read"]
  ): UnconstrainedBoundRole => ({
    name: "TestWorkflowTemplateRole",
    resourceType: "workflow_template",
    permissions,
    scope: createValidWorkflowTemplateScope(),
    scopeType: "workflow_template"
  })

  const createValidOrgRole = (permissions: SpacePermission[] = ["read"]): UnconstrainedBoundRole => ({
    name: "TestOrgRole",
    resourceType: "space", // org scopes are typically space roles
    permissions,
    scope: createValidOrgScope(),
    scopeType: "org"
  })

  describe("validateBoundRoles", () => {
    describe("good cases", () => {
      it("should accept empty array", () => {
        // Given
        const rolesData: unknown[] = []

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
        expect(result).toBeRightOf([])
      })

      it("should accept valid single group role", () => {
        // Given
        const rolesData = [createValidGroupRole()]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single space role", () => {
        // Given
        const rolesData = [createValidSpaceRole()]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single workflow template role", () => {
        // Given
        const rolesData = [createValidWorkflowTemplateRole()]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single org role", () => {
        // Given
        const rolesData = [createValidOrgRole(["read"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept multiple valid roles", () => {
        // Given
        const rolesData = [
          createValidGroupRole(["read", "write"]),
          createValidSpaceRole(["read", "manage"]),
          createValidWorkflowTemplateRole(["read", "vote"])
        ]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept all valid group permissions", () => {
        // Given
        const rolesData = [createValidGroupRole(["read", "write", "manage"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept all valid space permissions", () => {
        // Given
        const rolesData = [createValidSpaceRole(["read", "manage"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept all valid workflow template permissions", () => {
        // Given
        const rolesData = [createValidWorkflowTemplateRole(["read", "write", "instantiate", "vote"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept org role with any permission", () => {
        // Given
        const rolesData = [createValidOrgRole(["read", "manage"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      describe("invalid role structure", () => {
        it("should reject array with null role", () => {
          // Given
          const rolesData = [null]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject array with string role", () => {
          // Given
          const rolesData = ["not an object"]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role without name", () => {
          // Given
          const role = {
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role with empty name", () => {
          // Given
          const role = {
            name: "",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_name_empty")
        })

        it("should reject role with non-string name", () => {
          // Given
          const role = {
            name: 123,
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role without permissions", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role with non-array permissions", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: "read",
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role without scope", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group"
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })

        it("should reject role with null scope", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: null
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject role with non-object scope", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: "invalid"
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject role with scope without type", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {groupId: "group-123"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject role with non-string scope type", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {type: 123, groupId: "group-123"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })
      })

      describe("invalid permissions for scope types", () => {
        it("should reject invalid group permission", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["invalid_permission"],
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permission_invalid")
        })

        it("should reject workflow template permission on group scope", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["instantiate"], // valid for workflow template but not group
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permission_invalid")
        })

        it("should reject invalid space permission", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "space",
            permissions: ["write"], // not valid for space
            scopeType: "space",
            scope: createValidSpaceScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permission_invalid")
        })

        it("should reject invalid workflow template permission", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "workflow_template",
            permissions: ["manage"], // not valid for workflow template
            scopeType: "workflow_template",
            scope: createValidWorkflowTemplateScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permission_invalid")
        })

        it("should reject non-string permission", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: [123],
            scopeType: "group",
            scope: createValidGroupScope()
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })
      })

      describe("invalid scope structures", () => {
        it("should reject invalid scope type", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {type: "invalid_type"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject space scope without spaceId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "space",
            permissions: ["read"],
            scopeType: "space",
            scope: {type: "space"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject space scope with non-string spaceId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "space",
            permissions: ["read"],
            scopeType: "space",
            scope: {type: "space", spaceId: 123}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject group scope without groupId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {type: "group"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject group scope with non-string groupId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "group",
            permissions: ["read"],
            scopeType: "group",
            scope: {type: "group", groupId: 123}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject workflow_template scope without workflowTemplateId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "workflow_template",
            permissions: ["read"],
            scopeType: "workflow_template",
            scope: {type: "workflow_template"}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })

        it("should reject workflow_template scope with non-string workflowTemplateId", () => {
          // Given
          const role = {
            name: "TestRole",
            resourceType: "workflow_template",
            permissions: ["read"],
            scopeType: "workflow_template",
            scope: {type: "workflow_template", workflowTemplateId: 123}
          }
          const rolesData = [role]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_scope")
        })
      })

      describe("applicative validation behavior", () => {
        it("should return first validation error in array", () => {
          // Given
          const rolesData = [
            createValidGroupRole(["read"]), // valid
            null, // invalid - should cause failure
            createValidSpaceRole(["read"]) // valid but won't be reached
          ]

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_invalid_structure")
        })
      })
    })
  })

  describe("Group Role Factory Methods", () => {
    describe("createGroupReadOnlyRole", () => {
      it("should create group read-only role with correct properties", () => {
        // Given
        const scope = createValidGroupScope()

        // When
        const role = SystemRole.createGroupReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("GroupReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(scope)
      })

      it("should work with different scope types", () => {
        // Given
        const groupScope = createValidGroupScope()

        // When
        const role = SystemRole.createGroupReadOnlyRole(groupScope)

        // Then
        expect(role.name).toBe("GroupReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope.type).toBe("group")
      })
    })

    describe("createGroupWriteRole", () => {
      it("should create group write role with correct properties", () => {
        // Given
        const scope = createValidGroupScope()

        // When
        const role = SystemRole.createGroupWriteRole(scope)

        // Then
        expect(role.name).toBe("GroupWrite")
        expect(role.permissions).toEqual(["read", "write"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createGroupManagerRole", () => {
      it("should create group manager role with all permissions", () => {
        // Given
        const scope = createValidGroupScope()

        // When
        const role = SystemRole.createGroupManagerRole(scope)

        // Then
        expect(role.name).toBe("GroupManager")
        expect(role.permissions).toEqual(["read", "write", "manage"])
        expect(role.scope).toBe(scope)
      })
    })
  })

  describe("Space Role Factory Methods", () => {
    describe("createSpaceReadOnlyRole", () => {
      it("should create space read-only role with correct properties", () => {
        // Given
        const scope = createValidSpaceScope()

        // When
        const role = SystemRole.createSpaceReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("SpaceReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createSpaceManagerRole", () => {
      it("should create space manager role with correct properties", () => {
        // Given
        const scope = createValidSpaceScope()

        // When
        const role = SystemRole.createSpaceManagerRole(scope)

        // Then
        expect(role.name).toBe("SpaceManager")
        expect(role.permissions).toEqual(["read", "manage"])
        expect(role.scope).toBe(scope)
      })
    })
  })

  describe("Workflow Template Role Factory Methods", () => {
    describe("createWorkflowTemplateReadOnlyRole", () => {
      it("should create workflow template read-only role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowTemplateReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("WorkflowTemplateReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowTemplateWriteRole", () => {
      it("should create workflow template write role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowTemplateWriteRole(scope)

        // Then
        expect(role.name).toBe("WorkflowTemplateWrite")
        expect(role.permissions).toEqual(["read", "write"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowTemplateInstantiatorRole", () => {
      it("should create workflow template instantiator role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowTemplateInstantiatorRole(scope)

        // Then
        expect(role.name).toBe("WorkflowTemplateInstantiator")
        expect(role.permissions).toEqual(["read", "instantiate"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowTemplateVoterRole", () => {
      it("should create workflow template voter role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowTemplateVoterRole(scope)

        // Then
        expect(role.name).toBe("WorkflowTemplateVoter")
        expect(role.permissions).toEqual(["read", "vote"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowTemplateFullAccessRole", () => {
      it("should create workflow template full access role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowTemplateFullAccessRole(scope)

        // Then
        expect(role.name).toBe("WorkflowTemplateFullAccess")
        expect(role.permissions).toEqual(["read", "write", "instantiate", "vote"])
        expect(role.scope).toBe(scope)
      })
    })
  })

  describe("Workflow Role Factory Methods", () => {
    describe("createWorkflowReadOnlyRole", () => {
      it("should create workflow read-only role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("WorkflowReadOnly")
        expect(role.permissions).toEqual(["workflow_read"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowListRole", () => {
      it("should create workflow list role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowListRole(scope)

        // Then
        expect(role.name).toBe("WorkflowList")
        expect(role.permissions).toEqual(["workflow_read", "workflow_list"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowCancelRole", () => {
      it("should create workflow cancel role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowCancelRole(scope)

        // Then
        expect(role.name).toBe("WorkflowCancel")
        expect(role.permissions).toEqual(["workflow_read", "workflow_cancel"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowFullAccessRole", () => {
      it("should create workflow full access role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = SystemRole.createWorkflowFullAccessRole(scope)

        // Then
        expect(role.name).toBe("WorkflowFullAccess")
        expect(role.permissions).toEqual(["workflow_read", "workflow_list", "workflow_cancel"])
        expect(role.scope).toBe(scope)
      })
    })
  })
})
