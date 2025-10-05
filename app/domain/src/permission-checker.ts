import {
  UnconstrainedBoundRole,
  BoundRole,
  RoleScope,
  GroupPermission,
  SpacePermission,
  WorkflowTemplatePermission,
  GroupScope,
  SpaceScope,
  OrgScope,
  WorkflowTemplateScope
} from "./role"
import {User, OrgRole} from "./user"

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

export class RoleAuthorizationChecker {
  /**
   * Checks if a user can assign the specified roles to another entity
   * @param requestor The user requesting to assign roles
   * @param rolesToAssign Array of bound roles to be assigned
   * @returns true if the requestor has permission to assign all the roles
   */
  static canAssignRoles(requestor: User, rolesToAssign: ReadonlyArray<BoundRole>): boolean {
    return rolesToAssign.filter(boundRole => !this.canAssignRoleAtScope(requestor, boundRole)).length === 0
  }

  /**
   * Checks if a user can assign a specific role at a specific scope
   * @param requestor The user requesting to assign the role
   * @param boundRole The bound role to check
   * @returns true if the requestor has permission to assign this role at this scope
   */
  private static canAssignRoleAtScope(requestor: User, boundRole: BoundRole): boolean {
    if (requestor.orgRole === OrgRole.ADMIN) return true

    const scope = boundRole.scope

    switch (scope.type) {
      case "org":
        return false

      case "group":
        return RolePermissionChecker.hasGroupPermission(requestor.roles, scope, "manage")

      case "space":
        return RolePermissionChecker.hasSpacePermission(requestor.roles, scope, "manage")

      case "workflow_template":
        // For the moment this is can not be manager because there is no link to the parent space,
        // and it is required to validate that the requestor has the manage role on the parent.
        // TODO: This must be fixed in a subsequent PR once the link between workflow templates and
        // space is added.
        return false
    }
  }
}
