# D3: Workflow, vote, task and outbox repositories

Wave: [D](wave-D.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/database workflow/vote/task repositories; new outbox/dispatch/lease adapters; associated integration tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement tenant-qualified workflow/vote reads, atomic vote+recalculation marker/outbox operations, durable unique transition/action task generation, claim leases/fencing, dispatch attempts and reconciliation. Tenant sweep predicates use org and current time, stable pagination; directory enumeration is outside these adapters. Preserve actor snapshots on removal/revocation. Integrate C2 for task encryption outside retried DB sections. Atomic repository operations allow E4/E5 to persist business outcome+audit+outbox through the shared transaction without importing one another. The follow-up also adds per-consumer event receipts: recalculation and batched task generation commit receipts with their durable work; KMS encryption stays outside the retried task transaction.

## Acceptance

Direct SQL and adapter tests reject wrong-org workflow/template/voter/task relations. Concurrent duplicate event consumption creates one task per action; retained/replayed events cannot duplicate durable state. Stale lease owner cannot complete a reclaimed task. Verify atomic rollback of vote/outbox and safe expired-workflow pagination.

## Boundaries

No Bull relay/processors or workflow business rules (E4/E5), no network dispatch. DB fencing does not establish external exactly-once delivery.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
