# Workflow Templates

Workflow Templates are reusable blueprints that define the structure and approval logic for workflows. They act as the foundation for creating approval processes within your organization.

## Core Concepts

### Template Structure

A template serves as a comprehensive definition for a workflow process. It specifies the necessary approval rules, dictating exactly who can approve and what voting logic must be satisfied. It also outlines [actions](./workflow-actions.md), which are automated tasks—such as email notifications, Slack messages, or external webhooks—that the system will execute when specific conditions are met, like when a workflow is finally approved. Furthermore, the template system inherently supports versioning, allowing administrators to update templates while ensuring that existing workflows are safely preserved. Finally, every template requires a space assignment to ensure proper organizational grouping.

### Space Relationship

The relationship between a workflow template and a space is strict and permanent. Spaces serve as logical containers to organize related approval processes.

Every template must belong to exactly one space, tracked internally via a unique space identifier, and cannot exist independently. Once a template is created within a specific space, it cannot be moved to another space later. This tight coupling also means that if a space is ever deleted, all of its associated templates are inherently deleted as well.

For more information about spaces and how to organize your workflow templates, see [Spaces](./spaces.md).

### Permissions and Versioning

Permissions for Workflow Templates (such as who can view, instantiate, or vote) are bound to the stable template name rather than a specific revision ID. This design ensures that role assignments persist securely across template revisions, meaning administrators do not need to reassign permissions every time a template is updated to a new version.

### Template Lifecycle

Templates have three states:

| State                   | Description                                           |
| :---------------------- | :---------------------------------------------------- |
| **ACTIVE**              | Can create new workflows (only one "latest" version)  |
| **PENDING_DEPRECATION** | Being phased out, may have active workflows           |
| **DEPRECATED**          | Cannot create new workflows, voting may be restricted |
