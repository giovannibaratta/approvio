# Deployment Editions

Approvio is available in two editions:

- **Self-Hosted:** Run on your own servers, Kubernetes cluster, or private cloud.
- **Approvio Cloud:** A fully managed, hosted service operated by Approvio.

## Overview

| | Self-Hosted | Approvio Cloud |
| :--- | :--- | :--- |
| **Hosting** | Your infrastructure (on-premises, AWS, GCP, Azure, etc.) | Fully managed by Approvio |
| **Data Control** | Complete control; data stays in your network | Hosted in Approvio Cloud infrastructure |
| **Resource Limits** | No artificial caps on spaces, groups, templates, or workflows | Limits depend on your subscription plan |
| **Maintenance** | Self-managed upgrades and backups | Handled automatically by Approvio |
| **Pricing** | Free for noncommercial use; commercial license required for production enterprise use | Subscription-based plans |

## Editions

### Self-Hosted

Self-hosted Approvio is designed for teams that need full control over their deployment environment, data residency, and infrastructure.

To run Approvio self-hosted, set:

```bash
DEPLOYMENT_EDITION=self_hosted
```

In this mode:
- There are no built-in limits on the number of spaces, groups, users, workflow templates, or concurrent workflows.
- No usage throttling or billing checks are enforced by the software.

#### Licensing

Self-hosted Approvio is distributed under the [PolyForm Noncommercial License 1.0.0](../LICENSE). This license permits free use for personal study, research, evaluation, testing, non-profit organizations, and educational institutions.

Commercial deployment on private infrastructure requires a commercial license agreement with the copyright holder.

---

### Approvio Cloud

Approvio Cloud is our managed multi-tenant platform. It eliminates the operational overhead of deploying and maintaining backend infrastructure.

In Approvio Cloud:
- Organizations choose a subscription plan that fits their team size and approval volume.
- Workflows, spaces, and automated operations are governed by the allowances of your active plan.
- Organization administrators can inspect current usage and limits at any time through the dashboard or API.

## Related Documentation

- **[Quotas](./quotas.md)**: Resource limits, metrics, and plan baselines.
- **[Permissions](./permissions.md)**: User roles and access control.
- **[Roles](./roles.md)**: RBAC roles and administrative capabilities.
