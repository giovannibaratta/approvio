# Workflow Templates

Workflow Templates are reusable blueprints that define the structure and approval logic for workflows. They act as the foundation for creating approval processes within your organization.

## Core Concepts

### Template Structure

A template serves as a comprehensive definition for a workflow process. It specifies the necessary approval rules, dictating exactly who can approve and what voting logic must be satisfied. It also outlines actions, which are automated tasks—such as email notifications—that the system will execute when specific conditions are met, like when a workflow is finally approved. Furthermore, the template system inherently supports versioning, allowing administrators to update templates while ensuring that existing workflows are safely preserved. Finally, every template requires a space assignment to ensure proper organizational grouping.

### Automated Actions

Workflow templates can be configured to automatically execute actions when specific conditions are met, such as when a workflow reaches its final approved state. This enables seamless integration with other systems in your environment.

The system currently supports the following automated actions:

| Action Type   | Description                                                                  |
| :------------ | :--------------------------------------------------------------------------- |
| **`EMAIL`**   | Sends a standardized email notification to configured recipients.            |
| **`WEBHOOK`** | Sends an HTTP POST payload to an external URL, allowing custom integrations. |
| **`SLACK`**   | Dispatches a notification to a specific Slack channel or user via a webhook. |

### Space Relationship

The relationship between a workflow template and a space is strict and permanent. Spaces serve as logical containers to organize related approval processes.

Every template must belong to exactly one space, tracked internally via a unique space identifier, and cannot exist independently. Once a template is created within a specific space, it cannot be moved to another space later. This tight coupling also means that if a space is ever deleted, all of its associated templates are inherently deleted as well.

For more information about spaces and how to organize your workflow templates, see [Spaces](./spaces.md).

### Template Lifecycle

Templates have three states:

| State                   | Description                                           |
| :---------------------- | :---------------------------------------------------- |
| **ACTIVE**              | Can create new workflows (only one "latest" version)  |
| **PENDING_DEPRECATION** | Being phased out, may have active workflows           |
| **DEPRECATED**          | Cannot create new workflows, voting may be restricted |
