# Audit Logs

The Approvio platform includes a comprehensive auditing system that tracks modifications to core entities. The audit logs provide a reliable historical ledger of who changed what and when, ensuring accountability and data integrity across the system.

## Accessing Audit Logs

Access to the audit logs is strictly controlled to ensure sensitive organizational history is only visible to authorized personnel.

To view audit logs, a user must be assigned the **`AuditorViewer`** role. This role operates exclusively at the Organization (`org`) scope, meaning that once granted, the user has visibility into all audited events across all spaces and groups within the organization.

## Tracked Events

The auditing system focuses on tracking Create, Update, and Delete (CUD) operations for critical resources, as well as significant state changes.

Currently, the system tracks the following events:

| Audit Type             | Entity | Description                                                 |
| :--------------------- | :----- | :---------------------------------------------------------- |
| `SPACE_CREATED`        | Space  | Recorded when a new space is created.                       |
| `SPACE_DELETED`        | Space  | Recorded when a space is permanently deleted.               |
| `GROUP_CREATED`        | Group  | Recorded when a new group is created.                       |
| `MEMBERSHIPS_ADDED`    | Group  | Recorded when users or agents are added to a group.         |
| `MEMBERSHIPS_REMOVED`  | Group  | Recorded when users or agents are removed from a group.     |
| `USER_ROLES_ASSIGNED`  | User   | Recorded when new roles are assigned to a human user.       |
| `USER_ROLES_REMOVED`   | User   | Recorded when roles are removed from a human user.          |
| `AGENT_ROLES_ASSIGNED` | Agent  | Recorded when new roles are assigned to an automated agent. |
| `AGENT_ROLES_REMOVED`  | Agent  | Recorded when roles are removed from an automated agent.    |

## Audit Log Structure

Every audit log entry contains standardized metadata providing context about the event, along with a structured payload specific to the action performed.

### Standard Metadata

All audit logs share the following core attributes:

- **Entity ID**: The unique identifier of the resource that was modified (e.g., the Space ID or Group ID).
- **Entity Type**: The category of the resource (`SPACE`, `GROUP`, `USER`, or `AGENT`).
- **Audit Type**: The specific action that occurred (e.g., `SPACE_CREATED`).
- **Actor**: The entity that performed the action. This includes the Actor's ID and Type (`user` or `agent`), providing a clear "who" for every event.
- **Timestamp**: The exact date and time the action was recorded.

### Event Payloads

The `payload` field contains a JSON object detailing the specific changes made during the event. The structure of this payload varies depending on the `Audit Type`.

**Examples:**

- **Creation Events (`SPACE_CREATED`, `GROUP_CREATED`)**: The payload typically includes foundational details like the `name` and `description` of the newly created resource.
- **Membership Events (`MEMBERSHIPS_ADDED`, `MEMBERSHIPS_REMOVED`)**: The payload contains an array of `members`, specifying the ID and type (user or agent) of each entity affected by the change.
- **Role Events (`USER_ROLES_ASSIGNED`, `AGENT_ROLES_REMOVED`)**: The payload contains an array of `roles`, detailing the `roleName` and the exact `scope` (e.g., Space ID, Template ID) where the role was applied or removed.
- **Deletion Events (`SPACE_DELETED`)**: Deletion events generally have an empty payload, as the primary information (which entity was deleted and by whom) is captured in the standard metadata.

## System Architecture

Approvio uses an append-only architecture for audit logs. Audit records are generated synchronously alongside the primary business transaction. Once recorded, audit logs are strictly immutable at the application level—they can never be updated or deleted. This ensures the integrity and reliability of the historical record for compliance and security reviews.
