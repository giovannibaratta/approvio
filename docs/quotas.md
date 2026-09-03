# Quotas

Quotas define limits on resources, concurrency, and monthly operational usage across Approvio. They prevent resource exhaustion and ensure predictable system operation.

## Quota Types

Approvio organizes quotas into three categories:

| Category | Metrics | Description |
| :--- | :--- | :--- |
| **Resource Limits** | `MAX_SPACES`, `MAX_GROUPS`, `MAX_ENTITIES_PER_GROUP`, `MAX_WORKFLOW_TEMPLATES_PER_SPACE`, `MAX_ROLES_PER_USER` | Caps the total number of items you can create. When a limit is reached, new items cannot be created until existing ones are removed or limits are increased. |
| **Concurrency Limits** | `MAX_CONCURRENT_WORKFLOWS`, `MAX_VOTES_PER_WORKFLOW` | Restricts simultaneous active operations, such as workflows running in parallel for a template. |
| **Monthly Usage** | `MAX_LLM_TOKENS_PER_MONTH`, `MAX_EVALUATIONS_PER_MONTH`, `MAX_CREDITS_PER_MONTH` | Monthly allowances for automated operations (like AI evaluation runs). These reset at the start of each billing period. |

## Evaluation Levels

Each quota metric applies at a specific level of the organization:

| Evaluation Level | Metric | Description |
| :--- | :--- | :--- |
| **Organization** | `MAX_SPACES` | Maximum spaces allowed in the organization |
| **Organization** | `MAX_GROUPS` | Maximum groups allowed in the organization |
| **Organization** | `MAX_LLM_TOKENS_PER_MONTH` | Maximum monthly token allowance |
| **Organization** | `MAX_EVALUATIONS_PER_MONTH` | Maximum monthly automated evaluations |
| **Organization** | `MAX_CREDITS_PER_MONTH` | Maximum monthly platform credits |
| **Space** | `MAX_WORKFLOW_TEMPLATES_PER_SPACE` | Maximum templates created within a single space |
| **Group** | `MAX_ENTITIES_PER_GROUP` | Maximum members (users and agents) in a single group |
| **Workflow Template** | `MAX_CONCURRENT_WORKFLOWS` | Maximum workflows running simultaneously for a template |
| **Workflow** | `MAX_VOTES_PER_WORKFLOW` | Maximum votes recorded on a single workflow |
| **User** | `MAX_ROLES_PER_USER` | Maximum distinct roles assigned to one user |

## How Limits Are Resolved

When the system checks a limit, it applies the most specific rule available:

1. **Resource Override:** A custom limit set directly on a specific resource (e.g. A higher template limit on an active space).
2. **Organization Override:** A custom limit set for the entire organization.
3. **Plan Tier Baseline:** The default allowance provided by your subscription plan.

If an explicit override exists, it takes precedence over the plan default.

## Managing and Viewing Quotas

### Custom Overrides (`/quotas`)

Administrators can inspect, create, update, and remove custom limits for organizations, spaces, groups, or templates via the `/quotas` endpoints:

- `GET /quotas`: List configured overrides with optional filters.
- `POST /quotas`: Create a custom limit override.
- `GET /quotas/:id`: View a specific limit.
- `PUT /quotas/:id`: Update an existing limit.
- `DELETE /quotas/:id`: Remove an override and revert to parent or plan defaults.

### Organization Entitlements (`GET /organizations/:orgId/entitlements`)

Allows any member of an organization to view active feature flags and resolved quota limits. An effective limit of `null` indicates unlimited capacity.

### Monthly Usage (`GET /organizations/:orgId/usage`)

Allows Organization Admins to monitor monthly consumption, in-progress allocations, and remaining balances for metered metrics.
