# D4: Quota, usage and audit repositories

Wave: [D](wave-D.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/database quota/usage-event/audit-log repositories; new platform-security/settlement adapters; governance persistence tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Require org selectors for quota targets, tenant audit and usage aggregates. Implement count/admission locking support, immutable usage/event duplicate validation and durable pending-settlement reconciliation records. Keep platform-security events distinct and preserve attribution without cascading actor/resource FKs. Add tenant-leading query usage matching B1 indexes; audit data read permissions remain service decisions.

## Acceptance

Wrong-org IDs and polymorphic targets cannot be read/mutated; duplicate event same facts is idempotent and different facts errors. Audit remains after member/resource removal. Usage aggregate and actor/me filtering cannot cross orgs. Transaction rollback covers governance writes and caller business mutation.

## Boundaries

No Redis reservation logic or governance services/controllers (E6). No new audit partition scheme or retention duration.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
