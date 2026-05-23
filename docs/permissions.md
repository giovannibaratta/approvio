# Permissions System

The permissions system controls access to resources and operations through a combination of organizational roles, group memberships, and fine-grained role-based access control (RBAC).

## Core Concepts

### Organizational Roles

Users are assigned organizational-level roles that provide foundational system-wide permissions.

| Role       | Description                                                                                                                                 |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **Admin**  | Full system access. They can manage all resources and users, override all permission checks, and assign any roles at any scope.             |
| **Member** | A standard user whose access is determined strictly by their specific role assignments. Members require explicit roles for resource access. |

### Group Membership

Groups are collections of users and agents that define who can participate in approval processes. These groups operate at an organization-wide scope, meaning they can be utilized across any space. They are flexible enough to include both human users and automated agents.

It is important to note that while group membership determines who is eligible to vote in a specific process, it is not sufficient on its own. To cast a vote on a workflow, an entity must belong to a required approval group **and** possess the voter role for the corresponding workflow template.

See [Groups](./groups.md) for more about group management.

### Fine-Grained RBAC

The system relies on a comprehensive role-based access control (RBAC) model. This model features various role types (such as Space, Group, Workflow Template, and Workflow roles) that operate at different scopes, ranging from organization-wide to specific resources. These roles grant specific permissions, such as the ability to read, write, manage, instantiate, vote, or cancel workflows, and can be assigned to both users and agents alike.

For detailed information about the role system, see [Roles](./roles.md).

## Permission Model

### How Permissions Work

Permissions follow a hierarchical model based on the scope of the assigned roles:

| Level | Scope | Description |
| :---- | :---- | :---------- |
| 1 | **Organization Admin** | Bypasses all permission checks, granting full access across the system. |
| 2 | **Organization-wide Roles** | Grants permissions that apply to all resources of that type across the organization. |
| 3 | **Space-scoped Roles** | Grants permissions that apply only to a specific space and the templates within it. |
| 4 | **Resource-specific Roles** | Grants precise permissions applied only to individual workflow templates or groups. |

### Voting Permissions

Voting on workflows requires multiple conditions:

**For Users and Agents:**

| Requirement          | Description                                                                       |
| :------------------- | :-------------------------------------------------------------------------------- |
| **Group Membership** | Must belong to a group referenced in the workflow's approval rules                |
| **Voter Role**       | Must have voter role for the workflow template (at org, space, or template scope) |
| **Workflow Status**  | Workflow must be in EVALUATION_IN_PROGRESS state                                  |
| **Template Status**  | Template must allow voting (not deprecated with voting disabled)                  |

**Example:**

```text
User "alice@company.com" can vote on a workflow if:
✓ Alice is a member of "Finance Approvers" group
✓ Alice has WorkflowTemplateVoter role for the template
✓ Workflow requires "Finance Approvers" group approval
✓ Workflow is actively accepting votes
```

### Resource Permissions

| Resource     | Permission        | Description                         |
| :----------- | :---------------- | :---------------------------------- |
| **Space**    | `read`            | View space information              |
| **Space**    | `manage`          | Modify and delete spaces            |
| **Template** | `read`            | View template details               |
| **Template** | `write`           | Modify template definitions         |
| **Template** | `instantiate`     | Create workflow instances           |
| **Template** | `vote`            | Vote on workflows from the template |
| **Workflow** | `workflow_read`   | View workflow details               |
| **Workflow** | `workflow_list`   | List workflows                      |
| **Workflow** | `workflow_cancel` | Cancel workflows                    |

## Security Considerations

### Vote Integrity

The system ensures vote integrity by validating voting permissions dynamically at the time a vote is cast, rather than at the time the workflow is created. Furthermore, if a template is changed after a workflow has been instantiated, those modifications do not retroactively alter the voting permissions for the existing workflows.

## Related Documentation

- **[Roles](./roles.md)**: Complete guide to the RBAC system, role types, and management
- **[Spaces](./spaces.md)**: Understanding spaces and space-level permissions
- **[Workflow Templates](./workflow-templates.md)**: Template permissions and voting configuration
- **[Agents](./agents.md)**: How agents fit into the permission model
