# Workflows

Workflows are specific instances of approval processes created from workflow templates. They represent actual approval requests that move through defined states based on user votes and business rules.

## Core Concepts

### Workflow Lifecycle

Workflows progress through several states:

| State                      | Description                                           |
| :------------------------- | :---------------------------------------------------- |
| **EVALUATION_IN_PROGRESS** | Waiting for votes, actively collecting approvals      |
| **APPROVED**               | Received sufficient approvals based on template rules |
| **REJECTED**               | Received a veto vote, blocking approval               |
| **EXPIRED**                | Reached expiration time without sufficient approvals  |
| **CANCELED**               | Manually canceled or template deprecated              |

## Voting System

### Who Can Vote

Both **users** and **agents** can vote on workflows if they meet the requirements:

**Voting Requirements:**

| Requirement          | Description                                                                                                    |
| :------------------- | :------------------------------------------------------------------------------------------------------------- |
| **Group Membership** | The entity must be a member of a group explicitly referenced in the workflow's approval rules.                 |
| **Voter Role**       | The entity must have been granted the voter role for the specific workflow template (see [Roles](./roles.md)). |
| **Workflow State**   | The targeted workflow must currently be in the EVALUATION_IN_PROGRESS state.                                   |
| **Template Config**  | The overarching workflow template must be configured to actively allow voting.                                 |

**Participants:**

- **Users**: Human participants who review details and cast votes through the user interface or API.
- **Agents**: Automated systems configured to vote programmatically based on pre-defined checks (see [Agents](./agents.md)).

### Vote Types

Both users and agents can cast two types of votes:

| Vote Type   | Description                                         |
| :---------- | :-------------------------------------------------- |
| **APPROVE** | Positive vote contributing to approval requirements |
| **VETO**    | Negative vote that immediately rejects the workflow |

### Approval Logic

The logic determining when a workflow is formally approved relies on multiple conditions being met simultaneously. First, the accumulated positive votes must satisfy all of the approval rules defined by the template. Second, there must be no veto votes cast by any user or agent. Finally, the workflow must be active; it cannot be expired or canceled. It is crucial to understand that a single veto vote will immediately reject the workflow, entirely overriding any number of accumulated approval votes.

### Multiple Votes

The voting system is designed to be flexible, permitting both users and agents to vote multiple times on the very same workflow. When an entity votes multiple times, each individual vote is recorded separately and appended with a precise timestamp. All of these recorded votes are continuously evaluated as part of the approval logic. This capability is especially beneficial for automated agents, as it allows them to re-evaluate conditions and update their stance over time without losing the historical context of their previous checks.
