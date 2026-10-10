# A1: Freeze interfaces, inventories and decisions

Wave: [A](wave-A.md). Dependencies: all tasks in every earlier wave; none in this wave.

Status: complete (planning gate). Outputs: [contracts](contracts.md), [source inventory](inventory.md), [verification and handoff](handoff-A1.md).

## Context and ownership

Backend and sibling repositories; planning/design files only.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). This task creates the frozen contracts.

## Implementation

Read LOW-LEVEL-DESIGN.md and ADR 010. Reconcile current checkout drift from 37f38f3; record the starting branch, clean/dirty state and full commit SHA for backend, API, SDK, frontend and CLI before assigning implementation branches. Inventory every route, every backend import from `@approvio/api`, persisted model, raw SQL path, job type, Redis key and encrypted field. Produce contracts.md containing exact TypeScript signatures/error unions, full endpoint old→new mapping, API-model/validator/consumer impact mapping, schema/FK/delete/RLS matrix, event/state schemas and task file ownership. Include TenantTransactionManager, authority resolver, lifecycle/dispatch admission, quota admission, audit/outbox, encryption, discovery and session ports. Freeze task/attempt relational representation and workflow-template identity and version naming. Record proposed defaults from the LLD as selected implementation assumptions; mark any changed decision explicitly. Resolve ADR 001 session lookup and ADR 009 quota concurrency precedence in favor of ADR 010. No upstream approval is assumed for publishing packages or resetting environments.

## Acceptance

Every ADR 010 launch requirement maps to a task; all cross-task interfaces have concrete request/result/error shapes. Check schema includes step-up receipts, durable settlement intents, leases and tombstones. The repository baseline manifest identifies existing non-ADR branches and dirty files so task branches do not discard or silently absorb them. Same-wave file ownership is disjoint; all implementation prerequisites come from earlier waves. A schema/route/port decision still marked TBD blocks this gate.

## Boundaries

No application changes. If a product choice truly cannot be resolved, isolate the affected task and ask for that specific decision; continue independent inventory.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
