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

### Vote Types

- **APPROVE**: Positive vote contributing to approval requirements
- **VETO**: Negative vote that immediately rejects the workflow

### Approval Logic

A workflow is approved when:

1. All approval rules are satisfied by current votes
2. No veto votes exist
3. Workflow hasn't expired or been canceled

A single veto vote immediately rejects the workflow regardless of approval votes.
