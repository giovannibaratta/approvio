# E6 organization-scoped entitlement plan

## Decision

Store the current plan tier on `organizations` as `plan_tier`. Keep it out of public organization
summaries. A separate entitlement table may be useful later, but is not needed for the current two
tiers.

`DEPLOYMENT_EDITION` identifies SaaS versus self-hosted mode. Provisioning applies the corresponding
fixed initial tier: SaaS organizations start at `FREE`, while self-hosted organizations use
`SELF_HOSTED_UNLIMITED` as the uniform entitlement representation. The tier is not an operator
configuration choice. The approved schema approach is to add `plan_tier` to the original organization
table definition, so this work does not need a later migration to backfill existing rows.

## Implementation boundary

1. Add `plan_tier` to the organization schema and generated Prisma model using the repository's
   Liquibase workflow. Keep its value required and validate values through the domain `PlanTier`.
2. Persist the tier selected by the fixed provisioning policy as part of organization provisioning.
3. Add a narrow tenant-scoped entitlement read port using the restricted tenant Prisma client.
   Keep Prisma out of services and controllers, and keep `plan_tier` out of public organization DTOs.
4. Resolve the organization's tier in quota, feature-gate, and usage-metering decisions. Keep reads
   in short tenant transactions; do Redis/network work outside those transactions. Resolve the tier
   once per usage summary rather than once per metric.
5. Validate two organizations in one deployment can resolve distinct tiers, and that provisioning
   and usage/quota/feature behavior all use the target organization's tier.

## Initial tier for new organizations

Select the initial tier from deployment mode: `FREE` for SaaS and `SELF_HOSTED_UNLIMITED` for
self-hosted. This is product policy, not a deployment setting. A future billing flow can assign a
paid tier during SaaS signup; existing organizations retain their stored tier.

## Scope

- No billing integration, tier-change endpoint, per-feature override table, or public tier disclosure.
- No entitlement table in this implementation.
- Entitlement and usage URLs remain `/o/:organizationId/...`.

## Implementation status

The backend stores a required `organizations.plan_tier`, writes the configured default during
provisioning, and resolves feature gates, effective quotas, and usage limits from that tenant-scoped
value. Usage reads receive `TenantContext` and reject a requester whose active organization does not
match it. The entitlement repository uses the restricted tenant client; quota and usage tier reads
finish before external admission-cache calls. The focused E6 integration checks previously passed
(6 suites, 56 tests); after the usage service context change, its integration suite passed again
(1 suite, 11 tests), including the context-mismatch case. The latest full Jest run passed (109 suites,
1,064 tests) on 2026-09-23. `yarn tsc --noEmit`, `yarn build`, scoped ESLint, Prettier, and the
domain refresh-token suite pass after the latest code review changes. The full Liquibase changelog
and tenant-isolation acceptance passed on a fresh PostgreSQL 17 cluster. The linked API/SDK path
update remains pending.
