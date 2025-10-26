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

| Aspect | Agents | Users |
|--------|--------|-------|
| **Identity** | Machine/system name | Email-based human identity |
| **Authentication** | RSA key pair + JWT assertion | Password/token-based |
| **Voting** | Can vote on workflows | Can vote on workflows |
| **Group Membership** | Can be group members | Can be group members |
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

| Capability | Status | Details |
|------------|--------|---------|
| **Vote on workflows** | ✅ | Can cast APPROVE or VETO votes on workflows |
| **Check voting eligibility** | ✅ | Can query if they can vote on a specific workflow |
| **Join approval groups** | ✅ | Can be added to groups by organization admins |
| **Submit multiple votes** | ✅ | Can vote multiple times on the same workflow |
| **Register new agents** | ❌ | Only users with proper permissions can register agents |
| **Manage groups** | ❌ | Cannot add or remove group members |
| **Administrative operations** | ❌ | Cannot manage spaces or workflow templates |
| **Assign roles** | ❌ | Cannot assign roles to themselves or others |

**Requirements for voting:**
- Must have voter role for the specific workflow template
- Must be members of required approval groups

## Authentication Flow

Agents authenticate using a secure two-step challenge-response protocol:

```
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

**Step 1: Request Challenge**
- Agent requests authentication challenge from server
- Provides its unique agent name

**Step 2: Receive Encrypted Challenge**
- Server generates a unique nonce (one-time code)
- Server encrypts the challenge using the agent's registered public key

**Step 3: Decrypt and Sign**
- Agent decrypts challenge using its private key
- Agent creates a JWT assertion including the nonce
- Agent signs the JWT with its private key

**Step 4: Receive Access Token**
- Server validates the JWT signature using agent's public key
- Server verifies the nonce matches and hasn't been used before
- Server issues an access token for API operations
