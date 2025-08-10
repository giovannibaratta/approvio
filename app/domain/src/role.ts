import {PrefixUnion} from "@utils"
import {Either, left, right, traverseArray, chainFirstW} from "fp-ts/Either"
import {pipe} from "fp-ts/function"

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
type ScopeValidationError = "invalid_scope"
type ResourceValidationError = "resource_id_invalid" | "resource_required_for_scope" | "resource_not_allowed_for_scope"
type IdValidationError = "invalid_uuid"

export type RoleValidationError = PrefixUnion<
  "role",
  | NameValidationError
  | PermissionValidationError
  | ScopeValidationError
  | ResourceValidationError
  | IdValidationError
  | "invalid_structure"
>

export class RoleFactory {
  /**
   * Validates an array of bound roles from external data
   * @param rolesData Array data that should represent BoundRole array
   * @returns Either validation error or validated roles array
   */
  static validateBoundRoles(rolesData: unknown): Either<RoleValidationError, ReadonlyArray<BoundRole<string>>> {
    if (!Array.isArray(rolesData)) return left("role_permissions_empty")

    return traverseArray(this.validateRole)(rolesData)
  }

  private static validateRole(role: unknown): Either<RoleValidationError, BoundRole<string>> {
    const value = pipe(
      role,
      RoleFactory.validateRoleStructure,
      chainFirstW(boundRole => RoleFactory.validateRoleName(boundRole.name)),
      chainFirstW(boundRole =>
        RoleFactory.validatePermissionsForScope([...boundRole.permissions], boundRole.scope.type)
      )
    )

    return value
  }

  private static validateRoleName(name: string): Either<PrefixUnion<"role", NameValidationError>, string> {
    if (!name) return left("role_name_empty")
    if (name.length > ROLE_NAME_MAX_LENGTH) return left("role_name_too_long")
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return left("role_name_invalid_characters")
    return right(name)
  }

  private static validateRoleStructure(
    role: unknown
  ): Either<"role_invalid_structure" | "role_invalid_scope", BoundRole<string>> {
    if (!role || typeof role !== "object") return left("role_invalid_structure")
    if (!("name" in role) || typeof role.name !== "string") return left("role_invalid_structure")
    if (
      !("permissions" in role) ||
      !Array.isArray(role.permissions) ||
      role.permissions.filter(p => typeof p !== "string").length > 0
    )
      return left("role_invalid_structure")

    if (!("scope" in role)) return left("role_invalid_structure")
    if (!RoleFactory.isValidRoleScope(role.scope)) return left("role_invalid_scope")

    return right(role as BoundRole<string>)
  }

  private static isValidRoleScope(scope: unknown): scope is RoleScope {
    if (!scope || typeof scope !== "object") return false
    if (!("type" in scope)) return false
    if (typeof scope.type !== "string") return false

    switch (scope.type) {
      case "org":
        return RoleFactory.isValidOrgRoleScope(scope)
      case "space":
        return RoleFactory.isValidSpaceRoleScope(scope)
      case "group":
        return RoleFactory.isValidGroupRoleScope(scope)
      case "workflow_template":
        return RoleFactory.isValidWorkflowTemplateRoleScope(scope)
      default:
        return false
    }
  }

  private static isValidOrgRoleScope(scope: object): scope is OrgScope {
    return "type" in scope && scope.type === "org"
  }

  private static isValidSpaceRoleScope(scope: object): scope is SpaceScope {
    return "type" in scope && scope.type === "space" && "spaceId" in scope && typeof scope.spaceId === "string"
  }

  private static isValidGroupRoleScope(scope: object): scope is GroupScope {
    return "type" in scope && scope.type === "group" && "groupId" in scope && typeof scope.groupId === "string"
  }

  private static isValidWorkflowTemplateRoleScope(scope: object): scope is WorkflowTemplateScope {
    return (
      "type" in scope &&
      scope.type === "workflow_template" &&
      "workflowTemplateId" in scope &&
      typeof scope.workflowTemplateId === "string"
    )
  }

  private static validatePermissionsForScope(
    permissions: unknown[],
    scopeType: string
  ): Either<RoleValidationError, unknown[]> {
    const validGroupPermissions: GroupPermission[] = ["read", "write", "manage"]
    const validSpacePermissions: SpacePermission[] = ["read", "manage"]
    const validWorkflowTemplatePermissions: WorkflowTemplatePermission[] = ["read", "write", "instantiate", "vote"]

    for (const permission of permissions) {
      if (typeof permission !== "string") return left("role_permission_invalid")

      switch (scopeType) {
        case "group":
          if (!validGroupPermissions.includes(permission as GroupPermission)) return left("role_permission_invalid")
          break
        case "space":
          if (!validSpacePermissions.includes(permission as SpacePermission)) return left("role_permission_invalid")
          break
        case "workflow_template":
          if (!validWorkflowTemplatePermissions.includes(permission as WorkflowTemplatePermission))
            return left("role_permission_invalid")
          break
        case "org":
          // Org scope can have any permission
          break
        default:
          return left("role_invalid_scope")
      }
    }

    return right(permissions)
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
