# Workflow Templates

Workflow Templates are reusable blueprints that define the structure and approval logic for workflows. They act as the foundation for creating approval processes within your organization.

## Core Concepts

### Template Structure

A template defines:

- **Approval Rules**: Who can approve and the voting logic
- **Actions**: Automated tasks like email notifications that will be performed by the system when specified conditions are met (e.g. workflow is approved)
- **Versioning**: Templates can be updated while preserving existing workflows

### Template Lifecycle

Templates have three states:

- **ACTIVE**: Can create new workflows (only one "latest" version)
- **PENDING_DEPRECATION**: Being phased out, may have active workflows
- **DEPRECATED**: Cannot create new workflows, voting may be restricted
