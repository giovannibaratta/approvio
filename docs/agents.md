# Agents

Agents are automated, non-human entities that represent systems, applications, or services within the approval management platform. They enable programmatic participation in approval workflows while maintaining security and access control.

## Core Concepts

### What Are Agents?

Agents are first-class entities in the system, similar to users but designed for machine-to-machine interactions. They possess a unique identity, typically a machine or system name, rather than a human email address. Instead of passwords or typical user tokens, agents authenticate using an asymmetric cryptographic key pair, employing a challenge-response mechanism to obtain access.

The primary purpose of an agent is to enable automated systems—such as CI/CD pipelines, monitoring systems, and automated compliance tools—to participate in approval workflows in a secure, programmatic manner.

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

A CI/CD pipeline agent can automatically approve deployments that pass all tests. To achieve this, the agent is added to the relevant approval group and assigned a voter role for the corresponding workflow template. Once the pipeline successfully completes its tests, the agent casts an approval vote, allowing the deployment to proceed without manual intervention.

#### Monitoring System Integration

A monitoring agent can act as a safeguard by vetoing deployments during system incidents. By continuously monitoring system health metrics, an agent with voting permissions can immediately cast a VETO vote if critical alerts become active, preventing potentially destabilizing changes.

#### Compliance Automation

Agents can be integrated into compliance checking systems to ensure regulatory requirements are met. The agent can validate necessary conditions and automatically vote to approve compliant changes, simultaneously providing an automated audit trail of the checks performed.

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

To participate in a workflow, an agent must have the voter role for the specific workflow template and must be a member of the required approval groups.

## Authentication Flow

Agents authenticate using a secure two-step challenge-response protocol:

```text
┌─────────┐                                            ┌─────────┐
│  Agent  │                                            │ Server  │
└────┬────┘                                            └────┬────┘
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

The authentication process begins when an agent requests a challenge from the server using its unique name. The server responds by generating a unique one-time code (nonce) and encrypting it with the agent's registered public key.

Upon receiving the encrypted challenge, the agent decrypts it using its private key. It then creates a signed assertion that includes this decrypted nonce. Finally, the agent submits this assertion back to the server. The server validates the signature, ensures the nonce has not been reused, and issues an access token granting the agent API access.
