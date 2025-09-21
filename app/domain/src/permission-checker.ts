import {
  UnconstrainedBoundRole,
  RoleScope,
  GroupPermission,
  SpacePermission,
  WorkflowTemplatePermission,
  GroupScope,
  SpaceScope,
  OrgScope,
  WorkflowTemplateScope
} from "./role"

export class RolePermissionChecker {
  /**
   * Generic permission checking method that handles scope matching and permission verification
   * @param roles Array of bound roles to check
   * @param scope The scope to check permissions for
   * @param permission The specific permission to verify
   * @returns true if the user has the required permission in the specified scope
   */
  private static hasPermission(
    roles: ReadonlyArray<UnconstrainedBoundRole>,
    scope: RoleScope,
    permission: string
  ): boolean {
    return roles.some(role => {
      // Check if the role has the required permission
      if (!role.permissions.some(p => p === permission)) return false

      // Check scope matching
      return this.scopeMatches(role.scope, scope)
    })
  }

  /**
   * Checks if a role's scope matches the requested scope
   * Org-level permissions apply to all resources (hierarchical)
   */
  private static scopeMatches(roleScope: RoleScope, requestedScope: RoleScope): boolean {
    // Org-level permissions apply to everything
    if (roleScope.type === "org") return true

    // Exact scope type match required for non-org scopes
    if (roleScope.type !== requestedScope.type) return false

    // For space scopes, check spaceId match
    if (roleScope.type === "space" && requestedScope.type === "space") {
      return roleScope.spaceId === requestedScope.spaceId
    }

    // For group scopes, check groupId match
    if (roleScope.type === "group" && requestedScope.type === "group") {
      return roleScope.groupId === requestedScope.groupId
    }

    // For workflow template scopes, check workflowTemplateId match
    if (roleScope.type === "workflow_template" && requestedScope.type === "workflow_template") {
      return roleScope.workflowTemplateId === requestedScope.workflowTemplateId
    }

    return true
  }

  static hasGroupPermission(
    roles: ReadonlyArray<UnconstrainedBoundRole>,
    scope: GroupScope,
    permission: GroupPermission
  ): boolean {
    return this.hasPermission(roles, scope, permission)
  }

  static hasSpacePermission(
    roles: ReadonlyArray<UnconstrainedBoundRole>,
    scope: SpaceScope | OrgScope,
    permission: SpacePermission
  ): boolean {
    return this.hasPermission(roles, scope, permission)
  }

  static hasWorkflowTemplatePermission(
    roles: ReadonlyArray<UnconstrainedBoundRole>,
    scope: WorkflowTemplateScope | SpaceScope | OrgScope,
    permission: WorkflowTemplatePermission
  ): boolean {
    return this.hasPermission(roles, scope, permission)
  }
}
