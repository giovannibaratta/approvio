# Groups

Groups are collections of users and agents that define who can participate in approval processes. They operate at an organization-wide scope, meaning they can be utilized across any space.

## Core Concepts

### What Are Groups?

Groups act as an organizational boundary to collect multiple entities under a single identity for workflow participation. Groups are flexible enough to include both human users and automated agents.

**Examples:**

A group could represent a specific team such as "Finance Approvers", a functional role like "Security Reviewers", or a hybrid of both.

## Membership Management

Entities (Users and Agents) can be added or removed from groups. The ability to manage memberships relies on the group's Role-Based Access Control (RBAC).

### Roles and Permissions

Group management requires the user to hold appropriate permissions.

| Role              | Permissions               | Description                                       |
| :---------------- | :------------------------ | :------------------------------------------------ |
| **GroupReadOnly** | `read`                    | View group information and membership list        |
| **GroupWrite**    | `read`, `write`           | View and modify group basic settings              |
| **GroupManager**  | `read`, `write`, `manage` | Full control over the group, including membership |

_Note: Group roles only support group scope (they cannot be organization-wide)._

### Orphan Prevention

To prevent a group from becoming unmanageable, the system enforces an orphan prevention mechanism. When a membership is removed, the system validates if the removal would leave the group without any human administrator.

Specifically, it ensures that at least one human user with the `manage` permission remains in the group. Agents cannot act as group administrators. If an operation would remove the last human administrator, it will be rejected.

## Interaction with Workflows

While group membership determines who is _eligible_ to vote in a specific process, it is not sufficient on its own.

To successfully cast a vote on a workflow, an entity must satisfy multiple conditions:

1. **Group Membership**: Must belong to a group explicitly referenced in the workflow's approval rules.
2. **Voter Role**: Must possess the voter role for the corresponding workflow template (e.g., `WorkflowTemplateVoter`).
3. **Workflow State**: The workflow must be in the `EVALUATION_IN_PROGRESS` state.

For more details on voting, see [Workflows](./workflows.md).
