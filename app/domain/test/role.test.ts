import {
  RoleFactory,
  BoundRole,
  RoleScope,
  GroupPermission,
  SpacePermission,
  WorkflowTemplatePermission
} from "../src/role"

describe("RoleFactory", () => {
  // Test data helpers
  const createValidOrgScope = (): RoleScope => ({
    type: "org"
  })

  const createValidSpaceScope = (): RoleScope => ({
    type: "space",
    spaceId: "space-123"
  })

  const createValidGroupScope = (): RoleScope => ({
    type: "group",
    groupId: "group-123"
  })

  const createValidWorkflowTemplateScope = (): RoleScope => ({
    type: "workflow_template",
    workflowTemplateId: "template-123"
  })

  const createValidGroupRole = (permissions: GroupPermission[] = ["read"]): BoundRole<string> => ({
    name: "TestGroupRole",
    permissions,
    scope: createValidGroupScope()
  })

  const createValidSpaceRole = (permissions: SpacePermission[] = ["read"]): BoundRole<string> => ({
    name: "TestSpaceRole",
    permissions,
    scope: createValidSpaceScope()
  })

  const createValidWorkflowTemplateRole = (
    permissions: WorkflowTemplatePermission[] = ["read"]
  ): BoundRole<string> => ({
    name: "TestWorkflowTemplateRole",
    permissions,
    scope: createValidWorkflowTemplateScope()
  })

  const createValidOrgRole = (permissions: string[] = ["any_permission"]): BoundRole<string> => ({
    name: "TestOrgRole",
    permissions,
    scope: createValidOrgScope()
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
        const rolesData = [createValidGroupRole(["read"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single space role", () => {
        // Given
        const rolesData = [createValidSpaceRole(["read"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single workflow template role", () => {
        // Given
        const rolesData = [createValidWorkflowTemplateRole(["read"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })

      it("should accept valid single org role", () => {
        // Given
        const rolesData = [createValidOrgRole(["custom_permission"])]

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
        const rolesData = [createValidOrgRole(["custom", "admin", "super_user"])]

        // When
        const result = RoleFactory.validateBoundRoles(rolesData)

        // Then
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      describe("invalid input types", () => {
        it("should reject null input", () => {
          // Given
          const rolesData = null

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permissions_empty")
        })

        it("should reject undefined input", () => {
          // Given
          const rolesData = undefined

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permissions_empty")
        })

        it("should reject string input", () => {
          // Given
          const rolesData = "not an array"

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permissions_empty")
        })

        it("should reject number input", () => {
          // Given
          const rolesData = 123

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permissions_empty")
        })

        it("should reject object input", () => {
          // Given
          const rolesData = {not: "an array"}

          // When
          const result = RoleFactory.validateBoundRoles(rolesData)

          // Then
          expect(result).toBeLeftOf("role_permissions_empty")
        })
      })

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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: "read",
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
            permissions: ["read"]
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["invalid_permission"],
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
            permissions: ["instantiate"], // valid for workflow template but not group
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
            permissions: ["write"], // not valid for space
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
            permissions: ["manage"], // not valid for workflow template
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
            permissions: [123],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
            permissions: ["read"],
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
        const role = RoleFactory.createGroupReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("GroupReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(scope)
      })

      it("should work with different scope types", () => {
        // Given
        const orgScope = createValidOrgScope()

        // When
        const role = RoleFactory.createGroupReadOnlyRole(orgScope)

        // Then
        expect(role.name).toBe("GroupReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(orgScope)
      })
    })

    describe("createGroupWriteRole", () => {
      it("should create group write role with correct properties", () => {
        // Given
        const scope = createValidGroupScope()

        // When
        const role = RoleFactory.createGroupWriteRole(scope)

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
        const role = RoleFactory.createGroupManagerRole(scope)

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
        const role = RoleFactory.createSpaceReadOnlyRole(scope)

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
        const role = RoleFactory.createSpaceManagerRole(scope)

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
        const role = RoleFactory.createWorkflowTemplateReadOnlyRole(scope)

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
        const role = RoleFactory.createWorkflowTemplateWriteRole(scope)

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
        const role = RoleFactory.createWorkflowTemplateInstantiatorRole(scope)

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
        const role = RoleFactory.createWorkflowTemplateVoterRole(scope)

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
        const role = RoleFactory.createWorkflowTemplateFullAccessRole(scope)

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
        const role = RoleFactory.createWorkflowReadOnlyRole(scope)

        // Then
        expect(role.name).toBe("WorkflowReadOnly")
        expect(role.permissions).toEqual(["read"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowListRole", () => {
      it("should create workflow list role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = RoleFactory.createWorkflowListRole(scope)

        // Then
        expect(role.name).toBe("WorkflowList")
        expect(role.permissions).toEqual(["read", "list"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowCancelRole", () => {
      it("should create workflow cancel role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = RoleFactory.createWorkflowCancelRole(scope)

        // Then
        expect(role.name).toBe("WorkflowCancel")
        expect(role.permissions).toEqual(["read", "cancel"])
        expect(role.scope).toBe(scope)
      })
    })

    describe("createWorkflowFullAccessRole", () => {
      it("should create workflow full access role", () => {
        // Given
        const scope = createValidWorkflowTemplateScope()

        // When
        const role = RoleFactory.createWorkflowFullAccessRole(scope)

        // Then
        expect(role.name).toBe("WorkflowFullAccess")
        expect(role.permissions).toEqual(["read", "list", "cancel"])
        expect(role.scope).toBe(scope)
      })
    })
  })
})
