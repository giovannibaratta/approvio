# Audit Logs

The system maintains comprehensive audit logs to track important state changes and operations across various resources. These logs provide visibility into system activities and are critical for security and compliance purposes.

## Core Concepts

Audit logs capture what happened, when it happened, who performed the action (the actor), and which resource was affected.

Each audit log entry includes:

- **ID**: A unique identifier for the log entry.
- **Created At**: The exact timestamp when the action occurred.
- **Actor**: The entity (user or agent) that triggered the action.
- **Entity Type**: The type of resource affected.
- **Entity ID**: The specific resource identifier.
- **Audit Type**: The specific action that was performed.
- **Payload**: Detailed, action-specific data about the change.

## Tracked Events

The system actively tracks the following events:

### Spaces

- **SPACE_CREATED**: Records when a new space is created, including its name and description.
- **SPACE_DELETED**: Records when an existing space is deleted.

### Groups

- **GROUP_CREATED**: Records when a new group is created, including its name and description.
- **MEMBERSHIPS_ADDED**: Records when new entities (users or agents) are added to a group.
- **MEMBERSHIPS_REMOVED**: Records when entities are removed from a group.

### Users & Agents

- **USER_ROLES_ASSIGNED**: Records when new roles (with their corresponding scopes) are assigned to a user.
- **USER_ROLES_REMOVED**: Records when roles are removed from a user.
- **AGENT_ROLES_ASSIGNED**: Records when new roles are assigned to an agent.
- **AGENT_ROLES_REMOVED**: Records when roles are removed from an agent.

## Access Control

Because audit logs contain sensitive organizational history and permission changes, access to them is strictly controlled.

Viewing audit logs requires the `AuditorViewer` role. This role contains the `read` permission on the `audit` resource.

_Note: The audit resource and `AuditorViewer` role only operate at the organization (`org`) scope, ensuring that auditors have system-wide visibility._

See [Roles](./roles.md) for more details on the permission system.
