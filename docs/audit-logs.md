# Audit Logs

Approvio records system-wide audit logs to track critical administrative and configuration events. These logs provide visibility into operations that affect permissions, organization structure, and user/agent access.

## Access Requirements

To view system-wide audit logs, users must possess the `AuditorViewer` role. This role provides the `read` permission specifically for the **Audit** resource and operates at the Organization-wide scope.

## Logged Events

The system tracks several types of administrative events across spaces, groups, users, and agents.

| Event Type             | Entity | Description                                 |
| :--------------------- | :----- | :------------------------------------------ |
| `SPACE_CREATED`        | Space  | A new space was created in the organization |
| `SPACE_DELETED`        | Space  | An existing space was deleted               |
| `GROUP_CREATED`        | Group  | A new group was created                     |
| `MEMBERSHIPS_ADDED`    | Group  | Users or agents were added to a group       |
| `MEMBERSHIPS_REMOVED`  | Group  | Users or agents were removed from a group   |
| `USER_ROLES_ASSIGNED`  | User   | Roles were assigned to a user               |
| `USER_ROLES_REMOVED`   | User   | Roles were removed from a user              |
| `AGENT_ROLES_ASSIGNED` | Agent  | Roles were assigned to an agent             |
| `AGENT_ROLES_REMOVED`  | Agent  | Roles were removed from an agent            |

## Payload Information

Each audit log entry captures essential context, including:

- **Entity Details:** The ID and Type (`SPACE`, `GROUP`, `USER`, `AGENT`) of the affected resource.
- **Actor:** The ID and Type (`user` or `agent`) of the entity that performed the action.
- **Timestamp:** The exact time the event occurred.
- **Specific Payload:** Additional details such as assigned role names, scope, added members, or space descriptions.
