import {
  GroupRole,
  GroupRoleTemplate,
  RoleScope,
  RoleTemplate,
  SpaceRole,
  SpaceRoleTemplate,
  WorkflowTemplateRole,
  WorkflowTemplateRoleTemplate,
  BoundRole,
  ScopeType,
  ResourceType
} from "./role"

/**
 * System role templates - hardcoded role definitions available in the system
 */
export class SystemRole {
  private static readonly ORG_SCOPE_TYPE_PREFIX = "OrgWide"
  private static readonly SPACE_SCOPE_TYPE_PREFIX = "SpaceWide"

  /**
   * Helper method to generate standardized role names based on scope
   */
  private static generateRoleName(baseRoleName: string, scopeType: ScopeType): string {
    switch (scopeType) {
      case "org":
        return `${SystemRole.ORG_SCOPE_TYPE_PREFIX}${baseRoleName}`
      case "space":
        return `${SystemRole.SPACE_SCOPE_TYPE_PREFIX}${baseRoleName}`
      case "group":
        return baseRoleName // Groups don't support wider scopes
      case "workflow_template":
        return baseRoleName // Workflow templates don't support wider scopes
    }
  }

  // Group role templates
  static getGroupReadOnlyTemplate(): GroupRoleTemplate {
    return {
      name: "GroupReadOnly",
      resourceType: "group",
      permissions: ["read"],
      scopeType: "group"
    }
  }

  static getGroupWriteTemplate(): GroupRoleTemplate {
    return {
      name: "GroupWrite",
      resourceType: "group",
      permissions: ["read", "write"],
      scopeType: "group"
    }
  }

  static getGroupManagerTemplate(): GroupRoleTemplate {
    return {
      name: "GroupManager",
      resourceType: "group",
      permissions: ["read", "write", "manage"],
      scopeType: "group"
    }
  }

  // Space role templates
  static getSpaceReadOnlyTemplate(scopeType: SpaceRoleTemplate["scopeType"] = "space"): SpaceRoleTemplate {
    const baseRoleName = "SpaceReadOnly"
    const name = scopeType === "space" ? baseRoleName : SystemRole.generateRoleName("SpaceReadOnly", scopeType)

    return {
      name,
      resourceType: "space",
      permissions: ["read"],
      scopeType: scopeType
    }
  }

  static getSpaceManagerTemplate(scopeType: SpaceRoleTemplate["scopeType"] = "space"): SpaceRoleTemplate {
    const baseRoleName = "SpaceManager"
    const name = scopeType === "space" ? baseRoleName : SystemRole.generateRoleName("SpaceManager", scopeType)

    return {
      name,
      resourceType: "space",
      permissions: ["read", "manage"],
      scopeType: scopeType
    }
  }

  // Workflow template role templates
  static getWorkflowTemplateReadOnlyTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowTemplateReadOnly"
    const name =
      scopeType === "workflow_template"
        ? baseRoleName
        : SystemRole.generateRoleName("WorkflowTemplateReadOnly", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["read"],
      scopeType: scopeType
    }
  }

  static getWorkflowTemplateWriteTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowTemplateWrite"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowTemplateWrite", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["read", "write"],
      scopeType: scopeType
    }
  }

  static getWorkflowTemplateInstantiatorTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowTemplateInstantiator"
    const name =
      scopeType === "workflow_template"
        ? baseRoleName
        : SystemRole.generateRoleName("WorkflowTemplateInstantiator", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["read", "instantiate"],
      scopeType: scopeType
    }
  }

  static getWorkflowTemplateVoterTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowTemplateVoter"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowTemplateVoter", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["read", "vote"],
      scopeType: scopeType
    }
  }

  static getWorkflowTemplateFullAccessTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowTemplateFullAccess"
    const name =
      scopeType === "workflow_template"
        ? baseRoleName
        : SystemRole.generateRoleName("WorkflowTemplateFullAccess", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["read", "write", "instantiate", "vote"],
      scopeType: scopeType
    }
  }

  // Workflow role templates (workflow permissions on template scope)
  static getWorkflowReadOnlyTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowReadOnly"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowReadOnly", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["workflow_read"],
      scopeType: scopeType
    }
  }

  static getWorkflowListTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowList"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowList", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["workflow_read", "workflow_list"],
      scopeType: scopeType
    }
  }

  static getWorkflowCancelTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowCancel"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowCancel", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["workflow_read", "workflow_cancel"],
      scopeType: scopeType
    }
  }

  static getWorkflowFullAccessTemplate(
    scopeType: WorkflowTemplateRoleTemplate["scopeType"] = "workflow_template"
  ): WorkflowTemplateRoleTemplate {
    const baseRoleName = "WorkflowFullAccess"
    const name =
      scopeType === "workflow_template" ? baseRoleName : SystemRole.generateRoleName("WorkflowFullAccess", scopeType)

    return {
      name,
      resourceType: "workflow_template",
      permissions: ["workflow_read", "workflow_list", "workflow_cancel"],
      scopeType: scopeType
    }
  }

  /**
   * Returns all predefined role templates available in the system.
   * Includes all scope variations for comprehensive coverage.
   */
  static getAllSystemRoleTemplates(): ReadonlyArray<RoleTemplate> {
    return [
      // Group role templates (only group scope supported)
      SystemRole.getGroupReadOnlyTemplate(),
      SystemRole.getGroupWriteTemplate(),
      SystemRole.getGroupManagerTemplate(),

      // Space role templates (space and org scopes)
      SystemRole.getSpaceReadOnlyTemplate("space"),
      SystemRole.getSpaceReadOnlyTemplate("org"),
      SystemRole.getSpaceManagerTemplate("space"),
      SystemRole.getSpaceManagerTemplate("org"),

      // Workflow template role templates (workflow_template, space, and org scopes)
      SystemRole.getWorkflowTemplateReadOnlyTemplate("workflow_template"),
      SystemRole.getWorkflowTemplateReadOnlyTemplate("space"),
      SystemRole.getWorkflowTemplateReadOnlyTemplate("org"),
      SystemRole.getWorkflowTemplateWriteTemplate("workflow_template"),
      SystemRole.getWorkflowTemplateWriteTemplate("space"),
      SystemRole.getWorkflowTemplateWriteTemplate("org"),
      SystemRole.getWorkflowTemplateInstantiatorTemplate("workflow_template"),
      SystemRole.getWorkflowTemplateInstantiatorTemplate("space"),
      SystemRole.getWorkflowTemplateInstantiatorTemplate("org"),
      SystemRole.getWorkflowTemplateVoterTemplate("workflow_template"),
      SystemRole.getWorkflowTemplateVoterTemplate("space"),
      SystemRole.getWorkflowTemplateVoterTemplate("org"),
      SystemRole.getWorkflowTemplateFullAccessTemplate("workflow_template"),
      SystemRole.getWorkflowTemplateFullAccessTemplate("space"),
      SystemRole.getWorkflowTemplateFullAccessTemplate("org"),

      // Workflow role templates (workflow permissions on various scopes)
      SystemRole.getWorkflowReadOnlyTemplate("workflow_template"),
      SystemRole.getWorkflowReadOnlyTemplate("space"),
      SystemRole.getWorkflowReadOnlyTemplate("org"),
      SystemRole.getWorkflowListTemplate("workflow_template"),
      SystemRole.getWorkflowListTemplate("space"),
      SystemRole.getWorkflowListTemplate("org"),
      SystemRole.getWorkflowCancelTemplate("workflow_template"),
      SystemRole.getWorkflowCancelTemplate("space"),
      SystemRole.getWorkflowCancelTemplate("org"),
      SystemRole.getWorkflowFullAccessTemplate("workflow_template"),
      SystemRole.getWorkflowFullAccessTemplate("space"),
      SystemRole.getWorkflowFullAccessTemplate("org")
    ]
  }

  /**
   * Creates a bound role by combining a role template with a specific scope
   */
  static createRoleForScope<T extends ResourceType>(template: RoleTemplate<T>, scope: RoleScope): BoundRole<T> {
    return {
      ...template,
      scope
    }
  }

  // Convenience methods for creating bound roles
  static createGroupReadOnlyRole(scope: RoleScope): GroupRole {
    return SystemRole.createRoleForScope(SystemRole.getGroupReadOnlyTemplate(), scope)
  }

  static createGroupWriteRole(scope: RoleScope): GroupRole {
    return SystemRole.createRoleForScope(SystemRole.getGroupWriteTemplate(), scope)
  }

  static createGroupManagerRole(scope: RoleScope): GroupRole {
    return SystemRole.createRoleForScope(SystemRole.getGroupManagerTemplate(), scope)
  }

  static createSpaceReadOnlyRole(scope: RoleScope): SpaceRole {
    return SystemRole.createRoleForScope(SystemRole.getSpaceReadOnlyTemplate(), scope)
  }

  static createSpaceManagerRole(scope: RoleScope): SpaceRole {
    return SystemRole.createRoleForScope(SystemRole.getSpaceManagerTemplate(), scope)
  }

  static createWorkflowTemplateReadOnlyRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowTemplateReadOnlyTemplate(), scope)
  }

  static createWorkflowTemplateWriteRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowTemplateWriteTemplate(), scope)
  }

  static createWorkflowTemplateInstantiatorRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowTemplateInstantiatorTemplate(), scope)
  }

  static createWorkflowTemplateVoterRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowTemplateVoterTemplate(), scope)
  }

  static createWorkflowTemplateFullAccessRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowTemplateFullAccessTemplate(), scope)
  }

  static createWorkflowReadOnlyRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowReadOnlyTemplate(), scope)
  }

  static createWorkflowListRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowListTemplate(), scope)
  }

  static createWorkflowCancelRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowCancelTemplate(), scope)
  }

  static createWorkflowFullAccessRole(scope: RoleScope): WorkflowTemplateRole {
    return SystemRole.createRoleForScope(SystemRole.getWorkflowFullAccessTemplate(), scope)
  }
}
