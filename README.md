Testing if workflow works
Another important change
Now we are generating the prisma schema

# Approvio Backend

A scalable approval management system built with NestJS and TypeScript that enables organizations to define, execute, and manage complex approval workflows at scale (or at least this is the goal 😄).

## Overview

Approvio is a backend service designed to streamline and automate approval processes within organizations. It provides a framework for creating approval workflow templates, managing approval rules, handling user permissions, and executing approval workflows with comprehensive audit trails.

> Approvio is not responsible for running your workflow. It is tool that you can integrate in your automated and non-automated workflows to obtain the required approval before running them.

### Example use cases

#### Financial approval

A company needs to implement an approval process for budget allocation requests. The business rule requires approval from three different stakeholders before any budget can be allocated:

- 1 Manager (from the requesting department)
- 1 VP (Vice President level approval)
- 1 Finance team member (for budget validation)

**Implementation with Approvio:**

1. **Create Groups**: Set up "Managers", "VPs", and "Finance" groups with appropriate members
2. **Define Template**: Create a workflow template with an AND approval rule:
   ```
   AND {
     GROUP_REQUIREMENT(Managers, minCount: 1),
     GROUP_REQUIREMENT(VPs, minCount: 1),
     GROUP_REQUIREMENT(Finance, minCount: 1)
   }
   ```
3. **Request Approval**: When a budget request is submitted, create a workflow instance
4. **Collect Votes**: Each group member can vote APPROVE or VETO through the API
5. **Automatic Resolution**: The workflow automatically becomes APPROVED when all three groups have provided at least one approval each

#### Multi-agent workflows (not yet implementable)

An autonomous agent needs to perform a potentially dangerous system operation (like deploying code to production or modifying critical infrastructure). To ensure safety, two additional AI agents must evaluate and approve the request before execution.

**Future Implementation with Approvio:**

1. **Agent Groups**: Create groups for "SecurityAI" and "InfrastructureAI" with the respective agent identities
2. **Safety Template**: Define a workflow template requiring approval from both agent groups:
   ```
   AND {
     GROUP_REQUIREMENT(SecurityAI, minCount: 1),
     GROUP_REQUIREMENT(InfrastructureAI, minCount: 1)
   }
   ```
3. **Automated Request**: The requesting agent creates a workflow with operation details
4. **AI Evaluation**: Each approver agent analyzes the request using their specialized models
5. **Programmatic Voting**: Agents vote via API calls based on their safety assessments
6. **Execution Gate**: The operation only proceeds if both agents approve, providing an automated safety checkpoint

> A human could be included in the loop based on the requirements.

### Key Capabilities

**Workflow Management**

- Create and manage reusable workflow templates with complex approval rules
- Support for AND/OR logic in approval rules with group-based requirements
- Configurable expiration times and automatic workflow lifecycle management

**Permission System**

- Role-based access control with group memberships
- Fine-grained voting permissions based on group membership and roles

**Approval Rules Engine**

- Group-based voting requirements with minimum vote thresholds
- Automatic vote consolidation and approval status calculation
- Support for veto votes and rejection workflows

## Getting Started

See [DEVELOPMENT.MD](./DEVELOPMENT.MD) for setup instructions, development commands, and architecture details.

## Documentation

For detailed information about the system architecture and components:

- [Workflow Templates](./docs/workflow-templates.md) - Template creation and management
- [Workflows](./docs/workflows.md) - Workflow execution and lifecycle
- [Permissions System](./docs/permissions.md) - User roles and access control
