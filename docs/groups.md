# Groups

Groups are collections of entities (users and agents) that define who can participate in approval processes. They are the primary mechanism for assigning voting responsibilities within workflows.

## Core Concepts

### What Are Groups?

A group is an organizational structure that allows multiple entities to be treated as a single collective unit for the purpose of approval workflows. Instead of assigning approval rules to specific individuals, you assign them to groups. This provides flexibility and resilience, ensuring that workflows do not stall if a specific individual is unavailable or leaves the organization.

Groups operate at the organization level, meaning a single group can be referenced by any workflow template across any space within the organization.

### Group Memberships

Groups can contain two types of entities:

- **Users**: Human participants who review details and cast votes through the user interface or API.
- **Agents**: Automated systems configured to vote programmatically based on pre-defined checks.

An entity can belong to multiple groups, and a group can contain multiple entities. The maximum number of entities a single group can hold is determined by the `MAX_ENTITIES_PER_GROUP` quota.

## Role Management

Access to manage groups is controlled through group-scoped roles. These roles determine who can view or modify the group's details and memberships.

| Role              | Permissions         | Description                                                      |
| :---------------- | :------------------ | :--------------------------------------------------------------- |
| **GroupReadOnly** | read                | View group information, including its members.                   |
| **GroupWrite**    | read, write         | Modify the group's name and description.                         |
| **GroupManager**  | read, write, manage | Full control, including the ability to add/remove group members. |

**Important Restrictions:**

- Every group must have at least one active **User** who holds the `GroupManager` role. The system prevents the removal of the last remaining group manager to ensure that the group does not become unmanageable.
- Automated agents cannot be group administrators.

## Integration with Workflows

### Approval Rules

When designing a workflow template, administrators define Approval Rules based on group requirements. For example, a template might require at least 2 votes from the "Finance Approvers" group and 1 vote from the "Legal Approvers" group.

### Voting Eligibility

Being a member of a required group is necessary but not sufficient on its own to vote on a workflow. To successfully cast a vote, an entity must satisfy two conditions simultaneously:

1. **Group Membership**: The entity must belong to a group explicitly referenced in the workflow's approval rules.
2. **Voter Role**: The entity must hold the `WorkflowTemplateVoter` role for the specific workflow template (either assigned directly at the template scope, or inherited from the space or organization scope).

### Dynamic Evaluation

Voting eligibility is evaluated dynamically at the time the vote is cast. If a user is added to a required group while a workflow is actively in progress, they immediately become eligible to vote. Conversely, if a user is removed from a group, they lose their eligibility, although any votes they cast prior to their removal remain valid and are retained in the workflow's history.

## Quotas

The group system is subject to two primary quotas:

- `MAX_GROUPS`: Enforced at the Organization level, this limits the total number of groups that can be created within the entire organization.
- `MAX_ENTITIES_PER_GROUP`: Enforced at the Group level (but configurable at the Organization level as a default), this limits the maximum number of members (users and agents combined) that can belong to a single group.
