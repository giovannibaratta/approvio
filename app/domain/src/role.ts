import {PrefixUnion} from "@utils"
import {Either, left, right} from "fp-ts/Either"

export const ROLE_NAME_MAX_LENGTH = 100
export const PERMISSION_NAME_MAX_LENGTH = 100

export type RoleScope = OrgScope | SpaceScope | GroupScope | WorkflowTemplateScope

export interface OrgScope {
  readonly type: "org"
}

export interface SpaceScope {
  readonly type: "space"
  readonly spaceId: string
}

export interface GroupScope {
  readonly type: "group"
  readonly groupId: string
}

export interface WorkflowTemplateScope {
  readonly type: "workflow_template"
  readonly workflowTemplateId: string
}

/**
 * A bound role is a role definition that is applied to a scope (that defines to which resources
 * the permissions applies)
 */
export interface BoundRole<AllowedPermission extends string> {
  readonly name: string
  readonly permissions: ReadonlyArray<AllowedPermission>
  readonly scope: RoleScope
}

export type GroupPermission = "read" | "write" | "manage"
export type SpacePermission = "read" | "manage"
export type WorkflowTemplatePermission = "read" | "write" | "instantiate" | "vote"
export type WorkflowPermission = "read" | "list" | "cancel"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface GroupRole extends BoundRole<GroupPermission> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SpaceRole extends BoundRole<SpacePermission> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface WorkflowTemplateRole extends BoundRole<WorkflowTemplatePermission> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface WorkflowRole extends BoundRole<WorkflowPermission> {}

type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
type PermissionValidationError = "permissions_empty" | "permission_invalid"
type ScopeValidationError = "scope_invalid"
type ResourceValidationError = "resource_id_invalid" | "resource_required_for_scope" | "resource_not_allowed_for_scope"
type IdValidationError = "invalid_uuid"

export type RoleValidationError = PrefixUnion<
  "role",
  NameValidationError | PermissionValidationError | ScopeValidationError | ResourceValidationError | IdValidationError
>

export class RoleFactory {
  /**
   * Validates an array of bound roles from external data
   * @param rolesData Array data that should represent BoundRole array
   * @returns Either validation error or validated roles array
   */
  static validateBoundRoles(rolesData: unknown): Either<RoleValidationError, ReadonlyArray<BoundRole<string>>> {
    if (!Array.isArray(rolesData)) {
      return left("role_permissions_empty")
    }

    // Validate each role in the array
    for (const role of rolesData) {
      if (!role || typeof role !== "object") {
        return left("role_permission_invalid")
      }

      const boundRole = role as Record<string, unknown>

      // Validate required properties
      if (typeof boundRole.name !== "string" || !boundRole.name) {
        return left("role_name_empty")
      }

      if (!Array.isArray(boundRole.permissions)) {
        return left("role_permissions_empty")
      }

      if (!boundRole.scope || typeof boundRole.scope !== "object") {
        return left("role_scope_invalid")
      }

      const scope = boundRole.scope as Record<string, unknown>
      if (typeof scope.type !== "string") {
        return left("role_scope_invalid")
      }

      // Validate permissions based on scope type
      const validationResult = this.validatePermissionsForScope(boundRole.permissions, scope.type)
      if (validationResult !== null) {
        return left(validationResult)
      }

      // Validate scope structure based on type
      const scopeValidation = this.validateScopeStructure(scope)
      if (scopeValidation !== null) {
        return left(scopeValidation)
      }
    }

    return right(rolesData as BoundRole<string>[])
  }

  private static validatePermissionsForScope(permissions: unknown[], scopeType: string): RoleValidationError | null {
    const validGroupPermissions: GroupPermission[] = ["read", "write", "manage"]
    const validSpacePermissions: SpacePermission[] = ["read", "manage"]
    const validWorkflowTemplatePermissions: WorkflowTemplatePermission[] = ["read", "write", "instantiate", "vote"]

    for (const permission of permissions) {
      if (typeof permission !== "string") {
        return "role_permission_invalid"
      }

      switch (scopeType) {
        case "group":
          if (!validGroupPermissions.includes(permission as GroupPermission)) {
            return "role_permission_invalid"
          }
          break
        case "space":
          if (!validSpacePermissions.includes(permission as SpacePermission)) {
            return "role_permission_invalid"
          }
          break
        case "workflow_template":
          if (!validWorkflowTemplatePermissions.includes(permission as WorkflowTemplatePermission)) {
            return "role_permission_invalid"
          }
          break
        case "org":
          // Org scope can have any permission
          break
        default:
          return "role_scope_invalid"
      }
    }

    return null
  }

  private static validateScopeStructure(scope: Record<string, unknown>): RoleValidationError | null {
    switch (scope.type) {
      case "org":
        // No additional properties needed
        return null
      case "space":
        if (typeof scope.spaceId !== "string") {
          return "role_resource_id_invalid"
        }
        return null
      case "group":
        if (typeof scope.groupId !== "string") {
          return "role_resource_id_invalid"
        }
        return null
      case "workflow_template":
        if (typeof scope.workflowTemplateId !== "string") {
          return "role_resource_id_invalid"
        }
        return null
      default:
        return "role_scope_invalid"
    }
  }

  // Group roles
  static createGroupReadOnlyRole(scope: RoleScope): GroupRole {
    return {
      name: "GroupReadOnly",
      permissions: ["read"],
      scope
    }
  }

  static createGroupWriteRole(scope: RoleScope): GroupRole {
    return {
      name: "GroupWrite",
      permissions: ["read", "write"],
      scope
    }
  }

  static createGroupManagerRole(scope: RoleScope): GroupRole {
    return {
      name: "GroupManager",
      permissions: ["read", "write", "manage"],
      scope
    }
  }

  // Space roles
  static createSpaceReadOnlyRole(scope: RoleScope): SpaceRole {
    return {
      name: "SpaceReadOnly",
      permissions: ["read"],
      scope
    }
  }

  static createSpaceManagerRole(scope: RoleScope): SpaceRole {
    return {
      name: "SpaceManager",
      permissions: ["read", "manage"],
      scope
    }
  }

  // Workflow template roles
  static createWorkflowTemplateReadOnlyRole(scope: RoleScope): WorkflowTemplateRole {
    return {
      name: "WorkflowTemplateReadOnly",
      permissions: ["read"],
      scope
    }
  }

  static createWorkflowTemplateWriteRole(scope: RoleScope): WorkflowTemplateRole {
    return {
      name: "WorkflowTemplateWrite",
      permissions: ["read", "write"],
      scope
    }
  }

  static createWorkflowTemplateInstantiatorRole(scope: RoleScope): WorkflowTemplateRole {
    return {
      name: "WorkflowTemplateInstantiator",
      permissions: ["read", "instantiate"],
      scope
    }
  }

  static createWorkflowTemplateVoterRole(scope: RoleScope): WorkflowTemplateRole {
    return {
      name: "WorkflowTemplateVoter",
      permissions: ["read", "vote"],
      scope
    }
  }

  static createWorkflowTemplateFullAccessRole(scope: RoleScope): WorkflowTemplateRole {
    return {
      name: "WorkflowTemplateFullAccess",
      permissions: ["read", "write", "instantiate", "vote"],
      scope
    }
  }

  // Workflow roles
  static createWorkflowReadOnlyRole(scope: RoleScope): WorkflowRole {
    return {
      name: "WorkflowReadOnly",
      permissions: ["read"],
      scope
    }
  }

  static createWorkflowListRole(scope: RoleScope): WorkflowRole {
    return {
      name: "WorkflowList",
      permissions: ["read", "list"],
      scope
    }
  }

  static createWorkflowCancelRole(scope: RoleScope): WorkflowRole {
    return {
      name: "WorkflowCancel",
      permissions: ["read", "cancel"],
      scope
    }
  }

  static createWorkflowFullAccessRole(scope: RoleScope): WorkflowRole {
    return {
      name: "WorkflowFullAccess",
      permissions: ["read", "list", "cancel"],
      scope
    }
  }
}
