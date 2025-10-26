# Workflow Templates

Workflow Templates are reusable blueprints that define the structure and approval logic for workflows. They act as the foundation for creating approval processes within your organization.

## Core Concepts

### Template Structure

A template defines:

- **Approval Rules**: Who can approve and the voting logic
- **Actions**: Automated tasks like email notifications that will be performed by the system when specified conditions are met (e.g. workflow is approved)
- **Versioning**: Templates can be updated while preserving existing workflows
- **Space Assignment**: Every template belongs to exactly one space for organizational grouping

### Space Relationship

Every workflow template must belong to a space. Spaces are logical containers that help organize related approval processes.

**Key Points:**
- Each template has a **spaceId** that identifies its parent space
- Templates cannot exist without a space
- Templates cannot be moved between spaces after creation
- When a space is deleted, all its templates are deleted

For more information about spaces and how to organize your workflow templates, see [Spaces](./spaces.md).

### Template Lifecycle

Templates have three states:

- **ACTIVE**: Can create new workflows (only one "latest" version)
- **PENDING_DEPRECATION**: Being phased out, may have active workflows
- **DEPRECATED**: Cannot create new workflows, voting may be restricted
