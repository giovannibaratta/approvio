# Workflows

Workflows are specific instances of approval processes created from workflow templates. They represent actual approval requests that move through defined states based on user votes and business rules.

## Core Concepts

### Workflow Lifecycle

Workflows progress through several states:

- **EVALUATION_IN_PROGRESS**: Waiting for votes, actively collecting approvals
- **APPROVED**: Received sufficient approvals based on template rules
- **REJECTED**: Received a veto vote, blocking approval
- **EXPIRED**: Reached expiration time without sufficient approvals
- **CANCELED**: Manually canceled or template deprecated

## Voting System

### Who Can Vote

Both **users** and **agents** can vote on workflows if they meet the requirements:

**Voting Requirements:**

- Must be a member of a group referenced in the workflow's approval rules
- Must have voter role for the workflow template (see [Roles](./roles.md))
- Workflow must be in EVALUATION_IN_PROGRESS state
- Workflow template must allow voting

**Users**: Human participants who vote through the user interface or API
**Agents**: Automated systems that vote programmatically (see [Agents](./agents.md))

### Vote Types

Both users and agents can cast two types of votes:

- **APPROVE**: Positive vote contributing to approval requirements
- **VETO**: Negative vote that immediately rejects the workflow

### Approval Logic

A workflow is approved when:

1. All approval rules are satisfied by current votes
2. No veto votes exist (from any user or agent)
3. Workflow hasn't expired or been canceled

A single veto vote immediately rejects the workflow regardless of approval votes.

### Multiple Votes

Both users and agents can vote multiple times on the same workflow:

- Each vote is recorded separately with timestamp
- All votes contribute to the approval evaluation
- Useful for agents that re-evaluate conditions over time
