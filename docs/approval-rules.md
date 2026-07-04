# Approval Rules

Approval Rules govern the logic for how workflows progress from the evaluation state to an approved state. These rules are embedded directly into Workflow Templates and define the specific voting conditions that must be satisfied for a workflow to be authorized.

## Core Concepts

Approval rules describe a hierarchy of conditions. A workflow is ultimately "APPROVED" when the accumulated, positive `APPROVE` votes mathematically satisfy the structural requirements defined in the template. If at any time a `VETO` vote is cast, it overrides all other rules, and the workflow is immediately rejected.

Approval rules evaluate votes cast by users and agents belonging to specific groups. The rules define not only which groups must participate but also the specific combination of group approvals necessary.

## Rule Types

The system supports three distinct types of approval rules, which can be combined to form complex decision trees. To maintain performance and prevent excessive complexity, rules can be nested to a maximum depth of two levels.

| Rule Type             | Description                                                                              | Evaluation Logic                                                                                                                    |
| :-------------------- | :--------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **GROUP_REQUIREMENT** | The base rule type. Specifies that approvals must come from members of a specific group. | Valid if the number of unique members from the specified group who cast `APPROVE` votes is greater than or equal to the `minCount`. |
| **AND**               | A logical conjunction of multiple nested rules.                                          | Valid only if _all_ nested rules evaluate to true.                                                                                  |
| **OR**                | A logical disjunction of multiple nested rules.                                          | Valid if _at least one_ nested rule evaluates to true.                                                                              |

### Group Requirement Properties

The `GROUP_REQUIREMENT` rule acts as the fundamental building block. It has the following key properties:

| Property                 | Description                                                                                                                                               |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **groupId**              | The unique identifier of the group whose members are eligible to satisfy this rule.                                                                       |
| **minCount**             | The minimum number of unique `APPROVE` votes required from members of this group.                                                                         |
| **requireHighPrivilege** | (Optional) If set to true, entities voting to satisfy this requirement must authenticate using a high-privilege token (e.g., via step-up authentication). |

## Examples of Logic

By combining `AND` and `OR` rules with `GROUP_REQUIREMENT` rules, you can accommodate various organizational policies.

**Example 1: Unanimous Multi-Department Approval**
An `AND` rule containing two `GROUP_REQUIREMENT` rules: one requiring 1 vote from "Finance" and another requiring 1 vote from "Security". Both groups must approve.

**Example 2: Escalation Paths**
An `OR` rule containing two `GROUP_REQUIREMENT` rules: one requiring 3 votes from standard "Engineers", and another requiring just 1 vote from "Engineering Leads".

## High Privilege Requirements

Approval rules can enforce stricter security for sensitive operations by enabling `requireHighPrivilege` on a `GROUP_REQUIREMENT`. When this is enabled, the system verifies that the token used to submit the vote has been obtained via a high-privilege authentication flow.

If an entity attempts to cast a vote satisfying a high-privilege requirement using a standard token, the vote will be rejected, and the user must re-authenticate to obtain elevated privileges. This ensures that critical decisions are made with active user confirmation, protecting against hijacked sessions.

For details on configuring these authentication flows, see [Authentication](./authentication.md).
