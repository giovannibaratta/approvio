# Agents

Agents are automated, non-human entities that represent systems, applications, or services within the approval management platform. They enable programmatic participation in approval workflows while maintaining security and access control.

## Core Concepts

### What Are Agents?

Agents are first-class entities in the system, similar to users but designed for machine-to-machine interactions:

- **Identity**: Each agent has a unique name and cryptographic key pair (RSA 4096-bit)
- **Authentication**: Agents use challenge-response authentication with JWT assertions
- **Purpose**: Enable automated systems to participate in approval workflows
- **Examples**: CI/CD pipelines, monitoring systems, automated compliance tools

### Agents vs Users

| Aspect                    | Agents                          | Users                           |
| ------------------------- | ------------------------------- | ------------------------------- |
| **Identity**              | Machine/system name             | Email-based human identity      |
| **Authentication**        | RSA key pair + JWT assertion    | Password/token-based            |
| **Voting**                | Can vote on workflows           | Can vote on workflows           |
| **Group Membership**      | Can be group members            | Can be group members            |
| **Administrative Access** | Cannot perform admin operations | Can have full admin permissions |

### Use Cases

#### Automated CI/CD Approvals

A CI/CD pipeline agent can automatically approve deployments that pass all tests:

- Agent is added to "CI Systems" group
- Agent has voter role for "Deployment Approval" workflow template
- Pipeline runs tests and votes to approve successful builds

#### Monitoring System Integration

A monitoring agent can veto deployments during incidents:

- Agent monitors system health metrics
- Agent has voter role for deployment workflows
- Agent casts VETO vote if critical alerts are active

#### Compliance Automation

A compliance checking agent can participate in approval processes:

- Agent validates regulatory requirements
- Agent votes to approve compliant changes
- Agent provides audit trail of automated checks

## Agent Capabilities

Agents have specific capabilities designed for automated workflow participation while maintaining security boundaries:

| Capability                    | Supported | Details                                                |
| ----------------------------- | --------- | ------------------------------------------------------ |
| **Vote on workflows**         | Yes       | Can cast APPROVE or VETO votes on workflows            |
| **Check voting eligibility**  | Yes       | Can query if they can vote on a specific workflow      |
| **Join approval groups**      | Yes       | Can be added to groups by organization admins          |
| **Submit multiple votes**     | Yes       | Can vote multiple times on the same workflow           |
| **Register new agents**       | No        | Only users with proper permissions can register agents |
| **Manage groups**             | No        | Cannot add or remove group members                     |
| **Administrative operations** | No        | Cannot manage spaces or workflow templates             |
| **Assign roles**              | No        | Cannot assign roles to themselves or others            |

**Requirements for voting:**

- Must have voter role for the specific workflow template
- Must be members of required approval groups

## Authentication Flow

Agents authenticate using a secure two-step challenge-response protocol:

```text
┌─────────┐                                           ┌─────────┐
│  Agent  │                                           │ Server  │
└────┬────┘                                           └────┬────┘
     │                                                      │
     │  1. Request Challenge                                │
     │  POST /auth/agents/challenge                         │
     │─────────────────────────────────────────────────────>│
     │                                                      │
     │  2. Encrypted Challenge (with nonce)                 │
     │  RSA-encrypted with agent's public key               │
     │<─────────────────────────────────────────────────────│
     │                                                      │
     │  [Agent decrypts challenge with private key]         │
     │                                                      │
     │  3. Signed JWT Assertion                             │
     │  POST /auth/agents/token (with decrypted nonce)      │
     │─────────────────────────────────────────────────────>│
     │                                                      │
     │  4. Access Token                                     │
     │  JWT token for API access                            │
     │<─────────────────────────────────────────────────────│
     │                                                      │
```

### Authentication Steps

1. **Request Challenge:** The agent requests an authentication challenge from the server, providing its unique name.
2. **Receive Encrypted Challenge:** The server generates a unique one-time code (nonce) and encrypts it using the agent's registered public key.
3. **Decrypt and Sign:** The agent decrypts the challenge using its private key, creates a JWT assertion that includes the nonce, and signs it.
4. **Receive Access Token:** The server validates the signature, ensures the nonce hasn't been used before, and issues an access token for API operations.
