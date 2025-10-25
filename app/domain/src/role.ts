/**
 * Role and Permission System
 *
 * This module implements a type-safe role-based access control system with three-way binding
 * to ensure compile-time safety and eliminate duplication.
 *
 * ## Architecture - Single Source of Truth Pattern
 *
 * The system uses a cascading dependency chain where each piece derives from a single source:
 *
 * 1. **RESOURCE_TYPES** (const array) - The independent source of truth
 *    - Defines all resources in the system: e.g. spaces, groups
 *
 * 2. **ResourceType** (derived type) - Extracted from RESOURCE_TYPES
 *    - Uses `(typeof RESOURCE_TYPES)[number]` to create a union type for the resources
 *
 * 3. **ALLOWED_SCOPE_TYPES_BY_RESOURCE** & **RESOURCE_PERMISSIONS** (const objects)
 *    - Both use `satisfies Record<ResourceType, ...>` constraint to guarantee all resource types are present
 *
 * 4. **Permission types** (derived types) - Extracted from RESOURCE_PERMISSIONS
 *    - Derive types for the permissions from the mapping RESOURCE_PERMISSIONS
 *
 * 5. **ResourceScopePermissionBinding** (derived type) - Ties everything together
 */

import {PrefixUnion} from "@utils"
import {Either, left, right, traverseArray, chainFirstW} from "fp-ts/Either"
import {pipe} from "fp-ts/function"

export const ROLE_NAME_MAX_LENGTH = 100
export const PERMISSION_NAME_MAX_LENGTH = 100
export const MAX_ROLES_PER_ENTITY = 128

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

export type RoleScope = OrgScope | SpaceScope | GroupScope | WorkflowTemplateScope
export type ScopeType = RoleScope["type"]

/**
 * All resource types in the system.
 *
 * This is the independent source of truth for what resources exist.
 * Everything else in the type system derives from this array.
 */
export const RESOURCE_TYPES = ["group", "space", "workflow_template"] as const

// Typescript type based on the RESOURCE_TYPES
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/**
 * Maps each resource type to its allowed scope types.
 *
 * The `satisfies Record<ResourceType, ReadonlyArray<ScopeType>>` constraint ensures:
 * - ALL ResourceType keys must be present (enforced at compile time)
 */
const ALLOWED_SCOPE_TYPES_BY_RESOURCE = {
  group: ["group"],
  space: ["space", "org"],
  workflow_template: ["workflow_template", "space", "org"]
} as const satisfies Record<ResourceType, ReadonlyArray<ScopeType>>

/**
 * Internal type that binds resource types to their allowed scopes and permissions.
 *
 * This mapped type iterates over each ResourceType and extracts:
 * - scopeType: Union of allowed scope types using `[K][number]` to extract from const array
 * - permission: Union of allowed permissions using `[K][number]` to extract from const array
 *
 * This ensures that RoleTemplate and BoundRole always use the correct scope and permission types
 * for each resource type, with perfect type safety.
 */
type ResourceScopePermissionBinding = {
  [K in ResourceType]: {
    scopeType: (typeof ALLOWED_SCOPE_TYPES_BY_RESOURCE)[K][number]
    permission: (typeof RESOURCE_PERMISSIONS)[K][number]
  }
}

/**
 * A role template defines a predefined role without being bound to specific resources.
 * It represents the hardcoded roles available in the system.
 */
export interface RoleTemplate<RType extends ResourceType = ResourceType> {
  readonly name: string
  readonly resourceType: RType
  readonly permissions: ReadonlyArray<ResourceScopePermissionBinding[RType]["permission"]>
  readonly scopeType: ResourceScopePermissionBinding[RType]["scopeType"]
}

/**
 * A bound role is a role definition that is applied to a scope (that defines to which resources
 * the permissions applies). It extends RoleTemplate with the full scope information.
 */
export interface BoundRole<RType extends ResourceType = ResourceType> extends RoleTemplate<RType> {
  readonly scope: RoleScope & {type: ResourceScopePermissionBinding[RType]["scopeType"]}
}

/**
 * Maps each resource type to its valid permissions.
 *
 * This is the single source of truth for permission definitions.
 * Permission types (GroupPermission, SpacePermission, etc.) are derived from this const.
 *
 * The `satisfies Record<ResourceType, ReadonlyArray<string>>` constraint ensures:
 * - ALL ResourceType keys must be present (enforced at compile time)
 */
const RESOURCE_PERMISSIONS = {
  group: ["read", "write", "manage"],
  space: ["read", "manage"],
  workflow_template: ["read", "write", "instantiate", "vote", "workflow_read", "workflow_list", "workflow_cancel"]
} as const satisfies Record<ResourceType, ReadonlyArray<string>>

/**
 * Permission types derived from RESOURCE_PERMISSIONS.
 * These extract the literal union type from the const arrays using `[number]` indexed access.
 */
export type GroupPermission = (typeof RESOURCE_PERMISSIONS)["group"][number]
export type SpacePermission = (typeof RESOURCE_PERMISSIONS)["space"][number]
export type WorkflowTemplatePermission = (typeof RESOURCE_PERMISSIONS)["workflow_template"][number]

// Template type aliases for unbound roles
export type GroupRoleTemplate = RoleTemplate<"group">
export type SpaceRoleTemplate = RoleTemplate<"space">
export type WorkflowTemplateRoleTemplate = RoleTemplate<"workflow_template">

// Bound role type aliases
export type GroupRole = BoundRole<"group">
export type SpaceRole = BoundRole<"space">
export type WorkflowTemplateRole = BoundRole<"workflow_template">

// Unconstrained bound role for cases where resource type is unknown
export type UnconstrainedBoundRole = BoundRole<ResourceType>

type NameValidationError = "name_empty" | "name_too_long" | "name_invalid_characters"
type PermissionValidationError = "permissions_empty" | "permission_invalid"
type ScopeValidationError = "invalid_scope"
type ResourceValidationError = "resource_id_invalid" | "resource_required_for_scope" | "resource_not_allowed_for_scope"
type IdValidationError = "invalid_uuid"
type RoleAssignmentValidationError =
  | "assignments_empty"
  | "assignments_exceed_maximum"
  | "total_roles_exceed_maximum"
  | "unknown_role_name"
  | "scope_incompatible_with_template"
  | "entity_type_role_restriction"

export type RoleValidationError = PrefixUnion<
  "role",
  | NameValidationError
  | PermissionValidationError
  | ScopeValidationError
  | ResourceValidationError
  | IdValidationError
  | RoleAssignmentValidationError
  | "invalid_structure"
>

export class RoleFactory {
  /**
   * Validates an array of bound roles from external data
   * @param rolesData Array data that should represent BoundRole array
   * @returns Either validation error or validated roles array
   */
  static validateBoundRoles(rolesData: unknown[]): Either<RoleValidationError, ReadonlyArray<BoundRole>> {
    return traverseArray(RoleFactory.validateRole)(rolesData)
  }

  /**
   * Validates that a scope is compatible with a role template
   */
  static validateScopeForTemplate(scope: RoleScope, template: RoleTemplate): Either<RoleValidationError, RoleScope> {
    // Check if scope type is allowed for this role template
    const allowedScopeTypes: ReadonlyArray<ScopeType> = ALLOWED_SCOPE_TYPES_BY_RESOURCE[template.resourceType]

    if (!allowedScopeTypes.includes(scope.type)) return left("role_scope_incompatible_with_template")
    if (!RoleFactory.isValidRoleScope(scope)) return left("role_invalid_scope")

    return right(scope)
  }

  /**
   * Consolidates roles by removing duplicates based on role name and scope
   */
  static consolidateRoles(roles: ReadonlyArray<BoundRole>): ReadonlyArray<BoundRole> {
    const seen = new Set<string>()
    const consolidated: BoundRole[] = []

    for (const role of roles) {
      const roleKey = `${role.name}-${JSON.stringify(role.scope)}`
      if (!seen.has(roleKey)) {
        seen.add(roleKey)
        consolidated.push(role)
      }
    }

    return consolidated
  }

  /**
   * Validates that roles can be assigned to a specific entity type
   */
  static validateRolesForEntityType(
    roles: ReadonlyArray<BoundRole>,
    targetEntityType: "user" | "agent"
  ): Either<RoleValidationError, ReadonlyArray<BoundRole>> {
    switch (targetEntityType) {
      case "user":
        return right(roles)
      case "agent":
        for (const role of roles)
          if (role.resourceType !== "workflow_template") return left("role_entity_type_role_restriction")
        return right(roles)
    }
  }

  /**
   * Compares two role scopes for equality
   * Matches scopes by type and their relevant IDs
   * @param scope1 First scope to compare
   * @param scope2 Second scope to compare
   * @returns true if scopes are equal, false otherwise
   */
  static isSameScope(scope1: RoleScope, scope2: RoleScope): boolean {
    if (scope1.type !== scope2.type) return false

    switch (scope1.type) {
      case "org":
        return true
      case "space":
        return scope1.spaceId === (scope2 as SpaceScope).spaceId
      case "group":
        return scope1.groupId === (scope2 as GroupScope).groupId
      case "workflow_template":
        return scope1.workflowTemplateId === (scope2 as WorkflowTemplateScope).workflowTemplateId
    }
  }

  private static validateRole(role: unknown): Either<RoleValidationError, BoundRole> {
    const value = pipe(
      role,
      RoleFactory.validateRoleStructure,
      chainFirstW(boundRole => RoleFactory.validateRoleName(boundRole.name)),
      chainFirstW(boundRole =>
        RoleFactory.validatePermissionsForResourceType([...boundRole.permissions], boundRole.resourceType)
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
  ): Either<"role_invalid_structure" | "role_invalid_scope", BoundRole> {
    if (!role || typeof role !== "object") return left("role_invalid_structure")
    if (!("name" in role) || typeof role.name !== "string") return left("role_invalid_structure")
    if (!("resourceType" in role) || typeof role.resourceType !== "string") return left("role_invalid_structure")
    if (!("scopeType" in role)) return left("role_invalid_structure")
    if (
      !("permissions" in role) ||
      !Array.isArray(role.permissions) ||
      role.permissions.filter(p => typeof p !== "string").length > 0
    )
      return left("role_invalid_structure")

    if (!("scope" in role)) return left("role_invalid_structure")
    if (!RoleFactory.isValidRoleScope(role.scope)) return left("role_invalid_scope")

    return right(role as BoundRole)
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

  private static validatePermissionsForResourceType(
    permissions: unknown[],
    resourceType: string
  ): Either<RoleValidationError, unknown[]> {
    if (!(resourceType in RESOURCE_PERMISSIONS)) return left("role_invalid_scope")

    const validPermissions = RESOURCE_PERMISSIONS[resourceType as ResourceType] as readonly string[]

    for (const permission of permissions) {
      if (typeof permission !== "string") return left("role_permission_invalid")
      if (!validPermissions.includes(permission)) return left("role_permission_invalid")
    }

    return right(permissions)
  }
}
