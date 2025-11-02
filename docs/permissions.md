# Permissions System

The permissions system controls access to resources and operations through a combination of organizational roles, group memberships, and fine-grained role-based access control (RBAC).

## Core Concepts

### Organizational Roles

Users have organizational-level roles that provide system-wide permissions:

- **Admin**: Full system access, can manage all resources and users
- **Member**: Standard user with permissions based on assigned roles

**Key Points:**

- Organization admins can override all permission checks
- Organization admins can assign any roles at any scope
- Members require specific role assignments for resource access

### Group Membership

Groups are collections of users and agents used for approval workflows:

- **Purpose**: Define who can participate in approval processes
- **Scope**: Organization-wide, can be used across any space
- **Members**: Can include both users and agents
- **Voting Eligibility**: Group membership is required but not sufficient for voting

To vote on a workflow, entities need **both**:

1. Membership in a required approval group
2. Voter role for the workflow template

See [Groups](./groups.md) for more about group management.

### Fine-Grained RBAC

The system uses a comprehensive role-based access control model with:

- **Role Types**: Space, Group, Workflow Template, Workflow roles
- **Scopes**: Organization-wide, space-specific, group-specific, template-specific
- **Permissions**: Read, write, manage, instantiate, vote, cancel, and more
- **Entities**: Roles can be assigned to both users and agents

For detailed information about the role system, see [Roles](./roles.md).

## Permission Model

### How Permissions Work

Permissions follow a hierarchical model:

1. **Organization Admin**: Bypasses all permission checks
2. **Organization-wide Roles**: Apply to all resources of that type
3. **Space-scoped Roles**: Apply to a space and its templates
4. **Resource-specific Roles**: Apply to individual templates or groups

### Voting Permissions

Voting on workflows requires multiple conditions:

**For Users and Agents:**

- **Group Membership**: Must belong to a group referenced in the workflow's approval rules
- **Voter Role**: Must have voter role for the workflow template (at org, space, or template scope)
- **Workflow Status**: Workflow must be in EVALUATION_IN_PROGRESS state
- **Template Status**: Template must allow voting (not deprecated with voting disabled)

**Example:**

```
User "alice@company.com" can vote on a workflow if:
✓ Alice is a member of "Finance Approvers" group
✓ Alice has WorkflowTemplateVoter role for the template
✓ Workflow requires "Finance Approvers" group approval
✓ Workflow is actively accepting votes
```

### Space Permissions

Control who can view and manage spaces:

- **read**: View space information
- **manage**: Modify and delete spaces

### Template Permissions

Control who can work with workflow templates:

- **read**: View template details
- **write**: Modify template definitions
- **instantiate**: Create workflow instances
- **vote**: Vote on workflows from the template

### Workflow Permissions

Control who can interact with workflow instances:

- **workflow_read**: View workflow details
- **workflow_list**: List workflows
- **workflow_cancel**: Cancel workflows

## Security Considerations

### Vote Integrity

- Vote permissions are validated at vote time, not workflow creation time
- Template changes don't affect existing workflow voting permissions

## Related Documentation

- **[Roles](./roles.md)**: Complete guide to the RBAC system, role types, and management
- **[Spaces](./spaces.md)**: Understanding spaces and space-level permissions
- **[Workflow Templates](./workflow-templates.md)**: Template permissions and voting configuration
- **[Agents](./agents.md)**: How agents fit into the permission model
