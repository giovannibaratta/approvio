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

| Use Case | Description |
| :------- | :---------- |
| **Automated CI/CD Approvals** | A CI/CD pipeline agent can automatically approve deployments that pass all tests by casting an approval vote when tests succeed. |
| **Monitoring System Integration** | A monitoring agent can act as a safeguard by vetoing deployments during system incidents by casting a VETO vote if critical alerts become active. |
| **Compliance Automation** | Agents can be integrated into compliance checking systems to validate necessary conditions and automatically vote to approve compliant changes, providing an automated audit trail. |

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

Agents authenticate using a secure two-step challenge-response protocol. The process involves the following steps:

| Step | Action |
| :--- | :----- |
| **1. Request Challenge** | The agent requests a challenge from the server using its unique name. |
| **2. Encrypted Challenge** | The server responds by generating a unique one-time code (nonce) and encrypting it with the agent's registered public key. |
| **3. Signed Assertion** | The agent decrypts the challenge using its private key, creates a signed assertion including this nonce, and submits it back to the server. |
| **4. Access Token** | The server validates the signature, ensures the nonce is unique, and issues an access token for API access. |
