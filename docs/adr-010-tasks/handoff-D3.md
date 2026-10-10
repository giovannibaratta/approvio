# D3 handoff — in progress

Implemented tenant-qualified workflow, vote and encrypted task persistence, a transactional tenant outbox adapter, and dispatch-admission adapter with task-state fencing. The 2026-09-23 source audit initially found that the frozen `tenant_event_receipts` contract had no schema table or adapter; the follow-up below records the subsequent implementation.

Verified on 2026-09-12:

- Scoped ESLint and filtered TypeScript checks pass for `workflow.repository.ts`, `vote.repository.ts`, `task.repository.ts`, `tenant-outbox.repository.ts`, and `dispatch-admission.repository.ts`, plus the changed task port.
- `yarn test:jest app/external/test/database/task.repository.integration.test.ts`: passed using the restricted worker role. It proves encrypted durable payload storage, foreign-organization denial, duplicate event/action rejection, and stale-owner completion rejection.
- `yarn test:jest app/external/test/database/tenant-outbox.repository.integration.test.ts`: passed; proves tenant-bound idempotent event append, worker-role claiming/fencing and acknowledgement. It does not prove durable per-consumer event receipts.
- `git diff --check` passes.

Barrier correction applied: task creation now receives immutable event identity, action index, initiating actor and availability metadata explicitly. The task port also propagates encryption/decryption failures. The adapter writes the B1 durable task fields, encrypts type-specific payloads with C2 tenant binding, and uses the fixed `approvio_worker_runtime` capability for organization, OCC, fencing and lease-owner guarded writes. Existing callers must be migrated in Wave E to supply the trusted context, immutable metadata and lease owner; D3 remains in progress until its coordinator-gate acceptance checks are run.

`yarn jest --runInBand app/external/test/database`: passed on 2026-09-23 (24 suites, 55 tests), including task, outbox, dispatch and tenant-qualified vote persistence plus concurrent provisioning.

Current coordinator follow-up: the workflow HTTP integration suite passes (1 suite, 54 tests). A new
failure-injection case raises an error during `workflow.recalculate` outbox insertion and verifies the
vote, workflow recalculation marker, and outbox row all roll back together. Replay/duplicate task
consumption, stale-lease completion at the integrated boundary, and the broader Wave D coordinator
gate remain open.

The receipt and replay gap noted in the initial audit is covered by the follow-up below. PostgreSQL
runtime acceptance and the Wave D gate remain required; see [PENDING.md](PENDING.md).

The expiration processor now calls the `WorkflowRecalculation` service port rather than its concrete
implementation, passing a shared cutoff and bounded batch size per organization. The duplicate
unbounded sweep method was removed. The worker expiration integration suite passes (1 suite, 5 tests),
including repeated one-item batches that verify deterministic progression through expired workflows.

## Receipt and replay follow-up — 2026-09-23

- Added the tenant-scoped `tenant_event_receipts` migration and test-template conversion. The B1 handoff
  accurately records that the table was absent at that earlier barrier; this D3 migration supplies the
  missing contract without rewriting applied changesets.
- Added a narrow service port and restricted receipt operation shared by tenant and worker transaction
  clients. Recalculation records its receipt with the workflow update/outbox work. Task generation encrypts
  all action payloads before opening one worker transaction that writes the receipt, all durable tasks,
  and all `task.ready` outbox rows.
- Deterministic pre-receipt task rows are reused only when their kind, event ID, and action index match.
  Concurrent duplicate consumers serialize on the receipt key; failure in any task/outbox write rolls
  back the receipt and complete batch.
- Added integration cases for duplicate receipt, consumer rollback, concurrent replay, task/outbox
  rollback, and lease reclamation. Static verification (`yarn tsc --noEmit`, scoped ESLint, contract
  verifier, and `git diff --check`) passes. The focused database suites cannot currently prepare their
  disposable database because PostgreSQL is unreachable; dev dependency startup failed in Podman user
  namespace setup. These runtime cases remain unverified.

## L03 runtime acceptance — 2026-09-28

The previously blocked PostgreSQL acceptance now runs on the prepared disposable profile. `yarn test:jest app/external/test/database app/worker/test/integration/workflow-task-generation.integration.test.ts app/worker/test/integration/workflow-actions-email.processor.integration.test.ts app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts` passes **29 suites, 82 tests**. This includes durable receipt duplicate/rollback, concurrent task generation, task/outbox/receipt rollback, outbox redelivery and receipt suppression, adapter dispatch fencing and unknown webhook retry.

Added two TaskService boundary tests in `app/worker/test/integration/workflow-actions-email.processor.integration.test.ts`, using the real worker module and restricted PostgreSQL adapters. A pre-send failed attempt is safely retried by a new owner; the old worker cannot mark sending or complete, and the new lease's work state remains unchanged. The valid new owner completes successfully. A separate test expires the stored lease deterministically after sending and proves completion returns `lease_lost` without changing either work or attempt rows. The fixture clock/lease manipulation is separate from runtime service calls; neither test sends a second email. The final email suite passes (5 tests).

Strengthened concurrent task-generation replay in `app/worker/test/integration/workflow-task-generation.integration.test.ts` with positive assertions for exactly one task-generation receipt and task-ready outbox row, in addition to the single durable task. Its final suite passes (5 tests), including atomic rollback and retry. Scoped lint and TypeScript pass; contract and diff checks pass. An initial new-test assertion incorrectly compared an Either to a TaskEither constructor; it was replaced with the repository's `toBeLeftOf` matcher before the passing run.

The L03 receipt/lease acceptance gap has runtime evidence. L03 remains open pending the shared fresh-database Wave D coordinator gate, which also needs L04 metering recovery. Existing early source/expiry-sweep/interface descriptions in this handoff are historical and do not replace current worker acceptance under L06.


## Fresh-database coordinator acceptance — 2026-09-28

The shared fresh-database blocker is resolved: all 41 Liquibase changesets replayed on a separate
empty PostgreSQL 17.4 cluster; tenant-isolation SQL and real tenant/worker capability logins passed.
The combined adapter/recovery/worker acceptance passed 30 suites and 103 tests; the full suite
passed 119 suites and 1,132 tests. Backend/worker build, TypeScript, scoped lint, contract and diff
checks passed. The commands and scope are recorded in [D4's handoff](handoff-D4.md).

L03 is complete and removed from `LEFT.md`. Broader service/worker and release gates remain open.
