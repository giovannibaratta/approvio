# E6: Organization quotas, usage, audit and capabilities

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

Quota/usage-metering/audit-log/feature-gate services and their controllers; Redis quota admission client and tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Remove default-org and global-admin assumptions. Resolve per-org entitlements and resource override hierarchy; verify resource target and actor ownership. Implement frozen transactional cardinality/concurrency admission port consumed by E3/E4. Meter reservations by immutable org/metric/period/operation identity with idempotent reserve/settle/cancel and mismatch rejection; reconcile durable settlement after Redis failure. Restrict suspension exceptions to approved management summaries. Tenant audit/me and capabilities/resource-governance responses cannot enumerate other organizations. Platform security storage is separate.

## Acceptance

Concurrent admission at final quota slot stays within limit. A/B reservations/cancel/settlement cannot affect one another; duplicated/reordered operations do not double-charge/release. Redis loss fails closed for new metered admission and replay restores cache from durable state. Audit/usage/controller tests enforce org and actor filters and preserved departed actor attribution.

## Boundaries

No edits to resource/workflow callers (E3/E4); B2 ports already define their call shape. Do not alter unrelated ADR 009 task files.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
