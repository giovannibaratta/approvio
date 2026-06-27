# Groups

Groups are collections of users and agents that define who can participate in approval processes. They operate at an organization-wide scope, meaning they can be utilized across any space.

## Core Concepts

### What Are Groups?

A group acts as a logical collection of entities within the Approvio system. These entities can be either human users or automated agents. Groups are primarily used to manage approval rules in workflows by allowing multiple entities to share the same participation logic.

**Key Properties:**

- **Name**: A descriptive name for the group (maximum 512 characters). Valid characters include letters, numbers, and hyphens.
- **Description**: An optional detailed description of the group's purpose (maximum 2048 characters).
- **Members**: Entities (users or agents) belonging to the group. A group must always maintain at least one human user with `manage` permissions, blocking the removal of the final administrator to prevent orphan groups.

### Group Membership and Voting

It is important to note that while group membership determines who is eligible to vote in a specific process, it is not sufficient on its own. To successfully cast a vote on a workflow, an entity must:

1. Belong to a required approval group for that workflow.
2. Possess the voter role for the corresponding workflow template.

For detailed information about roles and permissions, see [Roles](./roles.md).

### Quotas and Limits

The system enforces limits to maintain performance and avoid excessive resource consumption:

- **`MAX_ENTITIES_PER_GROUP`**: The maximum number of members (Users and Agents) that can belong to a single Group.
- **`MAX_GROUPS`**: The maximum number of Groups allowed within an Organization.

For more details on managing these limits, see [Quotas](./quotas.md).
