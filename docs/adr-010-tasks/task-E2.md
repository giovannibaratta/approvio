# E2: Organization lifecycle, membership and ownership APIs

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

New organization/membership/invitation services/controllers; existing organization-admin, user/agent administration and user-role/agent-role service/controller paths; associated tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement explicit creation, own membership discovery projection updates, owner/admin/member powers, multiple-owner protection, account-bound invitation acceptance and local membership removal/readmission. User APIs expose local profiles only, never other orgs/global recovery details. Agent creation/revocation and role grants remain tenant-local. Lifecycle uses A1 reason/access matrix: suspend, grace expiry, owner-vs-operator resume, deleting tombstone and credential blocking. Implement narrowly scoped audited bootstrap/recovery service port; operator command is F4. Emit transactional audit/outbox for lifecycle and authority changes; follow org lock order.

## Acceptance

Tests race last-owner removal/demotion, removal vs readmission, invitation reuse/wrong-account/expired/inviter-demoted, owner vs admin lifecycle permission and A/B admin isolation. History survives membership removal; roles/groups never silently return. Security suspension cannot be lifted by customer. Deleting denies tenant authority without deleting shared platform account.

## Boundaries

No authentication controllers/strategy (E1), group-membership CRUD (E3) or worker resume implementation (E5). Depend on frozen audit/outbox ports, not E6/E5 service bodies.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
