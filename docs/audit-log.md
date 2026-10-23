# Audit Log

The Audit Log system provides a centralized and immutable record of critical administrative and security events within the organization. This allows administrators to track changes, monitor security policies, and maintain compliance.

## Core Concepts

Audit logs track specific actions performed by entities (users or agents) on organizational resources. They are designed to provide visibility into structural changes to the platform, such as the creation of spaces or modification of permissions.

Audit logs are strictly readable and can never be modified or deleted once created, preserving an exact historical sequence of events.

## Tracked Events

The following table summarizes the key events tracked by the audit log system:

| Audit Type               | Entity Type | Description                                           |
| :----------------------- | :---------- | :---------------------------------------------------- |
| **SPACE_CREATED**        | `SPACE`     | A new space was created within the organization.      |
| **SPACE_DELETED**        | `SPACE`     | An existing space was permanently deleted.            |
| **GROUP_CREATED**        | `GROUP`     | A new group was created.                              |
| **MEMBERSHIPS_ADDED**    | `GROUP`     | Entities (Users or Agents) were added to a group.     |
| **MEMBERSHIPS_REMOVED**  | `GROUP`     | Entities (Users or Agents) were removed from a group. |
| **USER_ROLES_ASSIGNED**  | `USER`      | One or more roles were assigned to a user.            |
| **USER_ROLES_REMOVED**   | `USER`      | One or more roles were removed from a user.           |
| **AGENT_ROLES_ASSIGNED** | `AGENT`     | One or more roles were assigned to an agent.          |
| **AGENT_ROLES_REMOVED**  | `AGENT`     | One or more roles were removed from an agent.         |

## Audit Log Structure

Every audit log entry contains fundamental information that answers the "who, what, and when" for a given event.

| Field          | Description                                                                                                      |
| :------------- | :--------------------------------------------------------------------------------------------------------------- |
| **id**         | A unique deterministic identifier for the audit log entry.                                                       |
| **auditType**  | The specific action that occurred (e.g., `SPACE_CREATED`).                                                       |
| **entityType** | The category of the resource affected (e.g., `SPACE`, `GROUP`, `USER`, `AGENT`).                                 |
| **entityId**   | The unique identifier of the specific resource that was affected.                                                |
| **actor**      | The entity (User or Agent) that performed the action, including their `id` and `type`.                           |
| **createdAt**  | The exact timestamp when the event occurred.                                                                     |
| **payload**    | A context-specific set of data detailing the change (e.g., the roles assigned or the name of the created space). |

## Viewing Audit Logs

To view system-wide audit logs across the organization, a user or agent must possess the **AuditorViewer** role. This role provides the necessary read-only permissions to retrieve the historical records of changes.

For more information on the permission model, refer to [Permissions](./permissions.md) and [Roles](./roles.md).
