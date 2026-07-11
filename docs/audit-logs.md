# Audit Logs

The auditing system records critical events that happen within the platform.

## Event Types

| Audit Type | Entity Type | Description |
|---|---|---|
| `SPACE_CREATED` | `SPACE` | A new space was created. |
| `SPACE_DELETED` | `SPACE` | A space was deleted. |
| `GROUP_CREATED` | `GROUP` | A new group was created. |
| `MEMBERSHIPS_ADDED` | `GROUP` | Members were added to a group. |
| `MEMBERSHIPS_REMOVED` | `GROUP` | Members were removed from a group. |
| `USER_ROLES_ASSIGNED` | `USER` | Roles were assigned to a user. |
| `USER_ROLES_REMOVED` | `USER` | Roles were removed from a user. |
| `AGENT_ROLES_ASSIGNED` | `AGENT` | Roles were assigned to an agent. |
| `AGENT_ROLES_REMOVED` | `AGENT` | Roles were removed from an agent. |

## Viewing Audit Logs

Access to audit logs is controlled by the `AuditorViewer` role. This role provides `read` permission for the `audit` resource across the organization. Users with this role can view system-wide audit logs.
