# Quotas

The Quota system is designed to govern and restrict resource consumption within Approvio. It ensures that usage remains within predefined boundaries, preventing resource exhaustion and allowing administrators to enforce system constraints.

## High-Level Mechanism

The quota system operates by evaluating current resource usage against defined limits. Approvio uses a **hierarchical enforcement model**, allowing for flexible configuration at different levels of the organization.

### Hierarchical Enforcement

Quotas can be set at multiple levels in the resource hierarchy. While a metric has a "base level" where it is evaluated (for instance, `MAX_ENTITIES_PER_GROUP` is evaluated for a specific `Group`), the limit itself can be defined either directly on the resource for a specific limit, or inherited from an ancestor to act as a default limit defined at a higher level (e.g., a limit defined at the `Org` level that applies to all Groups within that Org).

When the system checks a quota, it traverses the hierarchy upwards starting from the resource being evaluated. The **first** (most specific) defined limit encountered is the one enforced.

### Key Characteristics

If no explicit quota is defined for a specific metric at any level of the hierarchy, the system will consider the usage as unlimited by default.

When enforcing these limits, the system performs a best-effort check. It evaluates the current usage count at the time of the request. Because this is a non-locking approach, the primary goal is to gracefully enforce limits generally, rather than enforcing absolute strictness in highly concurrent scenarios.

## Metrics and Evaluation Levels

Each quota metric is associated with a specific level in the resource hierarchy where usage is measured (the "Evaluation Level").

| Evaluation Level      | Metric                             | Description                                                                                      |
| :-------------------- | :--------------------------------- | :----------------------------------------------------------------------------------------------- |
| **Org**               | `MAX_GROUPS`                       | The maximum number of Groups allowed within an Organization.                                     |
| **Org**               | `MAX_SPACES`                       | The maximum number of Spaces allowed within an Organization.                                     |
| **Space**             | `MAX_WORKFLOW_TEMPLATES_PER_SPACE` | The maximum number of Workflow Templates that can be created within a single Space.              |
| **Group**             | `MAX_ENTITIES_PER_GROUP`           | The maximum number of members (Users and Agents) that can belong to a single Group.              |
| **Workflow Template** | `MAX_CONCURRENT_WORKFLOWS`         | The maximum number of active workflows that can be running simultaneously for a single Template. |
| **Workflow**          | `MAX_VOTES_PER_WORKFLOW`           | The maximum number of votes allowed for a specific Workflow.                                     |
| **User**              | `MAX_ROLES_PER_USER`               | The maximum number of roles that can be assigned to a single User.                               |

## Management

The quota system is managed exclusively through standard administrative APIs, requiring users to have proper administrative privileges for access control.

These dedicated endpoints, available under `/quotas`, allow administrators to create, view, update, and delete quota limits for any resource within the hierarchy. The APIs also support flexible filtering by resource type, specific metrics, and unique identifiers.
