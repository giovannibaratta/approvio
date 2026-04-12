# Quotas

The Quota system is designed to govern and restrict resource consumption within the application. It ensures that usage remains within predefined boundaries, preventing resource exhaustion and allowing administrators to enforce system constraints.

## High-Level Mechanism

The quota system operates by evaluating current resource usage against defined limits before allowing new resources to be created or specific actions to be performed.

Key characteristics of the quota mechanism include:
- **Default Unlimited:** If no explicit quota is defined for a specific metric and scope, the system considers the usage unlimited, and actions are permitted by default.
- **Best-Effort Checking:** The system performs a best-effort check to limit usage. It evaluates the current usage count at the time of the request. Note that this is a non-locking approach; the primary goal is to gracefully enforce limits generally rather than preventing highly concurrent edge-case overages.
- **Targeted vs. Global Limits:** Limits can be applied system-wide or restricted to specific target entities (like a specific Space or Group).

## Scopes and Metrics

Quotas are defined by a combination of a **Scope** (the level at which the limit is applied) and a **Metric** (the specific resource being limited).

The currently supported scopes and their associated metrics are:

### Global Scope (`GLOBAL`)
Limits applied system-wide, affecting the entire installation.
- **`MAX_GROUPS`**: The maximum total number of Groups allowed in the system.
- **`MAX_SPACES`**: The maximum total number of Spaces allowed in the system.

### Space Scope (`SPACE`)
Limits applied to an individual Space.
- **`MAX_TEMPLATES`**: The maximum number of Workflow Templates that can be created within a single Space.

### Group Scope (`GROUP`)
Limits applied to an individual Group.
- **`MAX_ENTITIES_PER_GROUP`**: The maximum number of members (both Users and Agents combined) that can belong to a single Group.

### Template Scope (`TEMPLATE`)
Limits applied to an individual Workflow Template.
- **`MAX_CONCURRENT_WORKFLOWS`**: The maximum number of active workflows that can be running simultaneously from a single Workflow Template.

### User Scope (`USER`)
Limits applied to an individual User.
- **`MAX_ROLES_PER_USER`**: The maximum number of roles that can be assigned to a single User.

## Management

Currently, the quota system is in its initial phase.

- **Current State:** Managing quotas (creating, updating, or deleting limits) is performed via direct system or database configuration. System administrators must interact with the database directly to set or modify the specific limits for the scopes and metrics.
- **Future Roadmap:** There are active roadmap items to expose these management functionalities via a dedicated API. This will eventually allow administrators to configure, enforce, and monitor quotas using standard administrative interfaces or infrastructure-as-code tools without requiring direct database access.
