# L06 worker acceptance — in progress

The current worker handoff contains historical design descriptions and intermediate failures. This
ledger records the current source and required evidence. L06 stays open until every required slice
passes real-adapter acceptance. A general full-suite pass does not establish the missing controls.

## Findings requiring implementation

- Dispatch has a fixed 60-second database lease but no per-organization concurrency admission,
  Redis dispatch lease or renewal implementation. Long egress and Redis-loss/cap fairness acceptance
  are consequently unproven and the frozen lease/cap requirements are not met.
- Suspension parking, bounded resume reconciliation and expiry before resumed dispatch need to be
  implemented and tested against the actual worker paths. `organization.resumed` currently has no
  queue route or consumer, and `LifecycleReconciliation` has no implementation. Existing completed/unknown-state lease tests
  do not prove these lifecycle controls.

## Acceptance slices

| Slice | Current evidence | Work left |
| --- | --- | --- |
| Stored ownership and forged jobs | Tenant-leading task selectors and receipt adapters exist | Verify forged event/task/org/version combinations at real processor boundaries |
| Fencing | L03 real expired/reclaimed completion tests pass | Long-running renewal, restart and cap-loss cases |
| Lifecycle | Locked claim/send admission, deterministic suspension race and in-flight completion pass | Durable parking, bounded resume and expiry |
| Outcomes/retries | Email/Slack transport ambiguity becomes unknown; webhook preserves task Idempotency-Key | Verify unknown parking and permanent/transient cases with real adapters |
| SSRF/redirects | SSRF client and redirect-disabled client exist | Map and rerun destination/redirect and worker failure acceptance |
| Outbox | Real PostgreSQL/Bull/Redis fairness, enqueue failure and accepted-job/acknowledgement-crash replay pass (three tests) | Dispatch consumer/restart and lifecycle reconciliation acceptance |

This is source evidence, not a completion claim. Scoped changes and exact runtime results will be
recorded as each slice is implemented and verified.

## Verified publishing and relay slice (2026-09-28)

Task repositories return committed task-ready events. `TaskService` enqueues them after the repository
transaction completes, then marks the corresponding outbox fact published. Each enqueue/mark operation
uses `bestEffort`; a failed queue or acknowledgement cannot roll back tasks or their generation receipt.
The database client no longer injects a queue provider or publishes through an async-local hook.
Direct repository calls persist facts only. A duplicate generation receipt returns no new events.

The generation integration suite observes committed task, receipt and outbox rows through an independent
connection during enqueue. It also proves failed enqueue preserves unpublished facts, replay does not
republish, and rollback never enqueues. The relay suite uses actual Bull queues and restricted database
adapters: a saturated organization receives at most ten claims per pass; suspended organizations are
skipped; pagination reaches an organization beyond the first fifty; enqueue failure does not block
another organization; and an accepted-job/acknowledgement crash recovers with a new fencing value.
A stale acknowledgement fails while the replacement lease is active. Acknowledgement of an already
published fact remains an idempotent success; that does not authorize any stale write.

Command (tenant/platform database URLs point to the fresh 43-changeset cluster on localhost:55434):

```sh
yarn test:jest \
  app/worker/test/integration/workflow-task-generation.integration.test.ts \
  app/worker/test/integration/workflow-task-generation-slack.integration.test.ts \
  app/worker/test/integration/workflow-events-queue-serialization.integration.test.ts \
  app/external/test/database/task.repository.integration.test.ts \
  app/services/test/durable-work/tenant-outbox-relay.service.integration.test.ts
```

Result: **5 suites / 14 tests passed**. The generation suite stubs queue delivery to inspect the commit
boundary; the relay suite exercises actual queues without task processors. These results prove this
slice, not the missing dispatch/lifecycle controls above. TypeScript and scoped ESLint passed.

The subsequent complete regression run passed **125 suites / 1,173 tests** using the same database
URLs and `yarn test:jest` without a file filter. `yarn build` built both backend and worker successfully;
`yarn tsc --noEmit --pretty false`, scoped ESLint, `node docs/adr-010-tasks/verify-contracts.mjs`, and
`git diff --check` passed. The count includes two new generation-boundary tests and three relay tests;
the two obsolete external auto-publishing helper tests were removed with that helper.

## Next implementation boundary

Dispatch lifecycle decisions belong to `TaskService`. It reads organization status before claim and
before the final transition to sending, in the same worker transaction as each dispatch update. The
status read does not lock the organization row: a worker may see the last committed `active` status
while a suspension is still uncommitted and admit work. That short race is accepted. Worker
credentials still use their restricted capability and cannot assume the tenant runtime role. Keep
external lease operations, queue publishing and delivery outside database transactions. Redis
concurrency leases must then integrate with claim, renewal and completion; implementing the unused
lease interface alone would not close the requirement.

### Worker transaction foundation (2026-09-28)

`WorkerDatabaseClient` now keeps an instance-local worker transaction context. Nested adapters reuse
its restricted projection, reject a different organization, and reject stronger isolation. The
`WORKER_TRANSACTION_MANAGER_TOKEN` binding uses the existing transaction-manager rollback/error
contract through `PrismaWorkerTransactionManager`; it does not acquire the tenant runtime role.
The shared manager accepts a database transaction boundary without requiring a full Prisma client.
No queue or external delivery occurs in this boundary.

Real PostgreSQL acceptance passed **4 suites / 23 tests**:

```sh
yarn test:jest \
  app/external/test/database/worker-transaction-manager.integration.test.ts \
  app/external/test/database/transaction-manager.integration.test.ts \
  app/external/test/database/task.repository.integration.test.ts \
  app/worker/test/integration/workflow-task-generation.integration.test.ts
```

The four new tests prove nested writes roll back on a business error, cross-org nesting never invokes
its computation, stronger nested isolation is rejected, and concurrent organizations stay isolated
with context cleared after commit. The existing tenant transaction/adapters remain passing. TypeScript,
scoped ESLint, contract and diff checks pass. The preceding full-suite result predates this foundation.

This foundation now supports the service-owned lifecycle admission implemented below. Parking/resume,
database collision retry and Redis cap/renewal integration remain open.

### Dispatch status checks with an accepted suspension race (2026-09-28)

`TaskService` reads organization status before claim and the final transition to sending. If it reads
suspended, deleting, or deleted, it parks the work. The read takes no row lock, so a worker can read
the previously committed `active` status while a concurrent suspension is still uncommitted and
admit work. This race is accepted. Recording an already-started attempt's outcome remains allowed
after suspension. The repository returns status only and applies no business decision.

The central organization capability profile grants the worker column-limited SELECT access to `id`
and `status`. The security trigger applies an RLS policy bound to the transaction organization
context. The worker has no organization-table UPDATE privilege. Required startup version is now
`20260926120000`.

The strict-lock version of this slice previously passed **4 suites / 16 tests** on localhost:55434.
The read-only status-check version has not been validated; the current Podman setup fails before Jest starts.

```sh
yarn test:jest \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts \
  app/worker/test/integration/workflow-actions-email.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-slack.processor.integration.test.ts
```

Six new tests cover a real worker login's context-only status access and denied directory-column access,
inactive claim rejection without durable mutation, suspension between claim and sending,
completion after suspension, and a deterministic admission wait behind an in-flight suspension.
The last test observes the database lock wait before committing suspension; it does not rely on a
fixed sleep to order the race. The earlier assertion that a NOINHERIT worker login could directly
execute without SET ROLE was corrected: production explicitly assumes the worker capability.

All **44 changesets replayed from empty** on the separately owned PostgreSQL 17.4 cluster
`approvio-adr010-worker-20260928`, localhost:55435. Tenant-isolation SQL and real capability-login checks
passed. The normal localhost:5433 template received the same additive application migration without
reset or checksum changes. Its test-only template changeset has a parameter-dependent historical
checksum: application-root update succeeded; no test-only history was cleared or rewritten.

Backend and worker builds passed. The first complete fresh-cluster regression passed all **1,183 test
assertions**, but **5 of 127 suites failed during cleanup hooks** (four five-second hooks and one
thirty-second hook). That is not a green full-suite result. New cleanup hooks now allow thirty seconds;
a bounded-concurrency (`--maxWorkers=4`) complete rerun is pending. The previous rerun was interrupted:
its process handle disappeared and its log was empty, so it supplied no acceptance evidence.

Durable parking has subsequently been implemented (see below). Bounded resume, cap/renewal and
restricted-worker module acceptance still prevent L06 closure.

Additional source finding: workflow recalculation/expiration and workflow event loading still use the
tenant transaction manager. The real worker login is explicitly denied membership of tenant/metering
roles by the capability-login test. Trace and validate the full worker module with actual restricted
credentials; fixture-admin-backed processor passes alone cannot prove deployment-role compatibility.

### Durable parking implementation — focused acceptance passed

Claim now returns an admitted/parked discriminated result. Inactive ready/retry-due work is paused
without creating an attempt. If suspension happens after claim, the sending transition pauses the
fenced work and closes the unsent attempt as failed with `organization_paused`; both writes commit
together. An already-sending attempt is never parked by this path. All three action processors return
success for parked work, so the current queue delivery is acknowledged without external egress.
Duplicate jobs targeting already-paused work are idempotent. Unknown delivery outcomes are not converted
to resumable paused work by ready parking.

The lifecycle tests now assert durable paused state and the terminal unsent-attempt category. A new
email processor test replays the stored task-ready event twice while suspended and asserts no email
call, no attempt and zero claim attempts. Resume/expiry reconciliation remains unimplemented; this
paragraph describes the implementation verified by the focused result below; broader worker acceptance remains open.

The first parking rerun failed in database cloning before reaching application code. The owned
PostgreSQL container had stale running metadata while OCI exec reported it absent. State sync/start
alone did not recover it; a non-destructive stop/start of only that owned container recovered PostgreSQL
and preserved migration history. Startup WAL recovery completed and readiness passed. Acceptance is
being rerun. The existing local test endpoint also failed cloning; no pre-existing container was reset.
TypeScript, scoped ESLint, contract verification and diff checks passed for the parking change.

After PostgreSQL recovery, startup next failed on refused Redis, then refused OIDC discovery. An owned
Redis 7.4 instance at localhost:6385 isolated this slice. The two dispatch test modules now disable only
OIDC discovery bootstrap: these assertions exercise no identity flow. No pre-existing container was
restarted or cleared. The email test's queue provider remains stubbed as before; it invokes the real
processor directly with the persisted task-ready event and observes actual restricted database writes.

Focused acceptance passed **2 suites / 7 tests (5 unrelated email tests skipped)**:

```sh
# Tenant/platform fixture database URLs target localhost:55435; Redis targets localhost:6385.
yarn test:jest \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts \
  app/worker/test/integration/workflow-actions-email.processor.integration.test.ts \
  -t 'context-bound|does not claim|denies sending|allows completion|waits for|acknowledges suspended'
```

This verifies the six lifecycle cases and the new duplicate suspended-job acknowledgement/no-egress
case. It does not revalidate the skipped real email delivery cases or the complete suite. Bounded
resume with expiry, Redis cap/renewal, durable recovery and restricted-worker module acceptance remain
open. The recovered cluster retains the existing 44-changeset migration history.

## Discussion checkpoint

The user requested stopping at the next gate to discuss the implementation. Work stops at the
current dispatch-parking verification checkpoint: seven focused tests, backend and worker builds,
TypeScript, scoped ESLint, contract and diff checks pass. L06 is not complete. Bounded resume/expiry,
lease/concurrency integration, collision recovery, restricted-worker module acceptance and the full
regression gate remain open. No subsequent feature work was started. Existing dirty work and owned
test environments are preserved for review.


## Resumed backend pass — 2026-10-04

User authorization resumes backend ledger work and excludes SDK/frontend work. The organization-status
service contract is now shared (`OrganizationStatusRepository` in tenancy); the external worker adapter
still joins the restricted dispatch transaction. Shared application modules do not yet select database
clients by API/worker entry point. Branded capability models and factories now validate native construction
and database mappings; specific validation and outbox errors propagate through services to controllers.
These changes do not implement concurrency admission, renewal, or resume reconciliation.

Source snapshot: backend branch `multi-org-support`, HEAD `84369860cf160766678060fa5b5289302fac6044`,
with existing staged, unstaged, and untracked changes. The SHA alone does not represent the tested working tree.

Commands on the current shared dirty checkout:

```sh
yarn tsc --noEmit -p tsconfig.json --pretty false
yarn test:jest \
  app/services/test/durable-work/models.test.ts \
  app/domain/test/events.test.ts \
  app/controllers/test/unit/organization.mappers.test.ts \
  app/services/test/usage-metering/usage-cache-recovery.test.ts \
  app/external/test/database/usage-operation.repository.integration.test.ts \
  app/external/test/database/task.repository.integration.test.ts \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts \
  app/external/test/database/tenant-outbox.repository.integration.test.ts \
  app/worker/test/integration/tenant-outbox-relay.processor.integration.test.ts \
  app/external/test/redis/quota-admission.integration.test.ts \
  app/worker/test/integration/usage-cache-recovery.integration.test.ts
```

Result: TypeScript passed; **11 suites / 146 tests passed**. Scoped ESLint across all touched model,
adapter, service, controller, and test files passed; `git diff --check` passed. The run uses isolated
test database fixtures and Redis prefixes. It is not a fresh-cluster replay, complete regression,
or proof that the full worker module runs under restricted production credentials. All unfinished
L06 slices remain open. Next: reconcile their current source, frozen contracts, and required real-adapter
checks before implementing bounded resume and Redis dispatch-cap/renewal integration.


### Worker transaction collision retries — 2026-10-04

The restricted worker client now retries the whole outer transaction using the configured attempt budget
and full-jitter backoff. Nested adapters reuse the active worker transaction; they do not retry a fragment
of it. The worker shares the tenant client's classifier for Prisma P2034 and direct PostgreSQL adapter
TransactionWriteConflict errors. Dispatch and outbox adapters preserve retryable failures until the outer
boundary can roll back and retry. Exhausted attempts return `retry_exhausted`; business Left results are
not retried. Outbox acknowledgement dependency failures are no longer mislabeled `lease_lost`.

Changed files: `app/external/src/database/database-client.ts`, `capability-database-client.ts`,
`dispatch-admission.repository.ts`, `tenant-outbox.repository.ts`, and
`app/external/test/database/worker-transaction-manager.integration.test.ts`.

The new tests use actual concurrent Serializable transactions and a shared read barrier, not mocked
failure responses. They prove fresh-snapshot retries retain both updates; a repository collision retries
the surrounding computation, then observes the winning lease and rolls back unrelated losing writes;
a one-attempt budget returns retry exhaustion. The existing business-rollback case now also asserts that
the computation executes once with a three-attempt retry budget.

```sh
yarn test:jest \
  app/external/test/database/worker-transaction-manager.integration.test.ts \
  app/external/test/database/transaction-manager.integration.test.ts \
  app/external/test/database/task.repository.integration.test.ts \
  app/external/test/database/tenant-outbox.repository.integration.test.ts \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts
```

Result: **5 suites / 25 tests passed**. After the acknowledgement mapper and non-retry assertion changes:

```sh
yarn test:jest \
  app/external/test/database/worker-transaction-manager.integration.test.ts \
  app/external/test/database/tenant-outbox.repository.integration.test.ts \
  app/worker/test/integration/tenant-outbox-relay.processor.integration.test.ts
```

Result: **3 suites / 15 tests passed**. Full TypeScript checking and scoped ESLint passed; diff checking
passed. The three repeated suites verify the final changes; these runs are not additive test counts.
The evidence covers worker database retries and nested dispatch rollback, not Redis renewal, resumed
dispatch, all worker repositories, or full restricted-login module startup. L06 remains open.

Resume semantics require clarification: workflows have a deadline and cancellation states; action tasks
have no deadline or cancellation state. The user notes that work can be aborted during suspension.
Clarify whether this means the workflow or an individual action task before implementing resume behavior.
In either case, resume must not revive work that was already aborted.


### Backend build and contract reconciliation — 2026-10-04

`yarn build` passed for backend and worker (both webpack compilations successful). Full TypeScript
checking after the final retry/acknowledgement changes passed. Contract verification initially failed
on five dead documentation links to the missing operator handoff and command guide. Source inventory
also contradicted the historical L05 closure: only the caller-authenticated recovery service is present.
The active ledger now reopens L05, preserves prior reports as historical, and removes dead evidence links.
These corrections do not implement the missing operator boundary or close L07.


After reconciliation, `node docs/adr-010-tasks/verify-contracts.mjs` passed: contract TypeScript checks,
63 API operation path mappings, and local Markdown links all passed. `git diff --check` passed.
SDK/frontend artifacts were not built or modified in this goal pass.

### Dispatch capacity and renewal adapters — 2026-10-04

Added a Redis `DispatchLeaseClient` adapter with atomic organization-scoped acquisition, renewal and
release. Configuration defaults to four concurrent slots per organization, a 60-second lease and a
15-second renewal interval; invalid values and renewal intervals at least as long as the lease are
rejected. Redis errors fail closed. Each acquisition requires an owner token; separate attempt tokens
prevent an old owner from renewing or releasing a replacement after Redis's fencing counter resets.

Added database dispatch lease renewal guarded by the persisted organization, task state, owner,
fencing token, unexpired lease and active attempt. Renewal retains the attempt and fencing token.
Real database fixtures shorten or expire leases and replace ownership rather than mocking service calls.

```sh
yarn test:jest \
  app/external/test/database/task.repository.integration.test.ts \
  app/external/test/redis/dispatch-lease.integration.test.ts \
  app/external/test/config/dispatch-config.test.ts
```

Result: **3 suites / 18 tests passed**. Full TypeScript and scoped ESLint passed. The Redis disconnection
test waits for the connection's terminal event before reconnecting, so cleanup does not race disconnect.

This is adapter acceptance only. TaskService and the delivery processors do not yet acquire, renew or
release capacity leases. Redis state-loss coverage proves stale-owner rejection, not recovery of
in-flight occupancy or enforcement of the physical delivery cap after state loss. End-to-end capacity,
heartbeat, cleanup and recovery acceptance remain open alongside bounded resume and restricted-worker
module wiring. L06 remains open.

### Delivery capacity lifecycle integration — 2026-10-04

Email, Slack and webhook processors now execute inside `TaskService.withDispatchLease`. It acquires
an organization capacity slot using a distinct execution owner, claims persisted work, renews both
capacity and database ownership, and checks both again immediately before egress. A stopped or
finished execution clears its timer, waits for pending renewal and releases its capacity slot.
Capacity cleanup errors are logged without replacing a persisted delivery outcome or its original
failure; unreleased slots expire. Database lease duration now uses the same configured duration as
Redis, so a longer configured renewal interval cannot outlive a hard-coded database lease.

Task identifiers may be UUIDv5 (existing deterministic action tasks) or UUIDv7; the Redis adapter's
original UUIDv7-only guard was corrected after real processor acceptance exposed the incompatibility.

```sh
yarn test:jest \
  app/worker/test/integration/workflow-actions-email.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-slack.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts \
  app/external/test/redis/dispatch-lease.integration.test.ts \
  app/external/test/database/task.repository.integration.test.ts \
  app/external/test/database/worker-transaction-manager.integration.test.ts
```

Result: **7 suites / 36 tests passed**; full TypeScript, scoped ESLint and diff checks passed. Controlled real-adapter service tests
hold four executions open, reject a fifth before database admission, verify persisted completion and
slot release, shorten a live database lease and observe heartbeat extension, and remove Redis capacity
state after admission to prove the immediate pre-egress check fails closed. Existing delivery processor
tests retain their delivery adapter fixtures; this is not a claim that every outbound transport used
a live external server.

Recovery of in-flight occupancy after Redis state loss remains open: rejecting the old owner does
not reconstruct slots or recall external calls already in flight. Bounded resume/cancellation semantics,
full restricted-worker module wiring and the remaining L06 matrix still require implementation and
acceptance. Earlier adapter-only limitations above describe the prior stage, superseded here for
processor integration and normal lifecycle renewal/cleanup only. L06 remains open.

### Durable capacity guard after Redis loss — 2026-10-04

Database admission now counts unexpired `claimed`/`sending` leases and claims the next task in one
Serializable transaction, using the configured organization cap. TaskService requests the same
isolation for its status/admission transaction. Retryable conflicts reach the existing whole-worker
transaction retry boundary; a fresh snapshot that observes the cap returns `capacity_exceeded`.
Redis admission and renewal remain required and fail closed when unavailable. No organization row
lock or new database capability was added.

The previous seven-suite command now passes **7 suites / 37 tests**. Full TypeScript, scoped ESLint
and diff checking pass. A real two-snapshot race over different task rows with cap one proves one
winner and a retried `capacity_exceeded` loser. The held-delivery test deletes all three organization
Redis lease keys, then proves the fifth execution is rejected before creating its database attempt.
A different organization completes while the first is saturated.

The held-delivery fixture uses eight bounded database retry attempts with jitter because four
simultaneous Serializable admissions can exhaust the default three-attempt budget; its admission
barrier now also observes rejected executions rather than hanging on a failed claim. Production keeps
the configured retry budget and Bull retries rejected jobs. Separate tests retain retry-exhaustion
coverage. These changes prove a live-lease bound, not a throughput SLA or recall of an expired call.

Contract reconciliation for the wave barrier: `DispatchAdmission.renew`, the capacity client's renewal
interval, and `WorkError.capacity_exceeded` are recorded in `contracts.md`; the live persisted capacity
guard is described in `LOW-LEVEL-DESIGN.md`. The current service models remain the authoritative branded
runtime contracts; this does not claim that all older documentation snippets are fully reconciled.

Restart recovery still needs implementation: current claim eligibility excludes expired `claimed`
and `sending` work. Pre-send abandoned claims can be retried after fencing; abandoned sending work
must become unknown, with email/Slack requiring explicit reconciliation and webhook retry requiring
its stable downstream idempotency key. Bounded lifecycle resume/cancellation and full restricted-worker
startup also remain open. L06 is not closed.

### Expired dispatch ownership recovery — 2026-10-04

`DispatchAdmission.recoverExpired` now reconciles the requested task before claim admission in the
same Serializable worker transaction. It checks persisted organization/kind, state, fencing and lease
expiry, clears abandoned ownership, increments fencing, and records the old attempt's outcome atomically.
Expired pre-send claims become `retry_due` and the old attempt becomes failed. Expired sending work
becomes `unknown`; email/Slack return a parked admission result without creating another attempt.
Webhook work may receive a fenced replacement only while active, using the existing immutable task ID
for downstream idempotency. During suspension it remains unknown without new dispatch. Parked here
means no execution lease; ambiguous work retains its persisted `unknown` state for reconciliation.

The preceding seven-suite command passes **7 suites / 41 tests** after the initial recovery changes.
The final suspension branch and added regression then passed:

```sh
yarn test:jest app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts
```

Result: **1 suite / 12 tests passed**. Full TypeScript passed before the final suspension-only branch;
the final focused suite type-checked that branch. Final scoped ESLint, contract verification and diff
checks passed. Counts are not additive. All recovery scenarios create real attempts and update their
persisted lease expiry; service/repository responses are not mocked. Tests prove abandoned pre-send
retry, stale-owner rejection, ambiguous email/Slack replay suppression, fenced webhook re-admission,
and recording uncertainty without dispatch during suspension.

Recovery is task-scoped and runs when a job is processed; these tests do not prove a process crash,
Bull stalled-job redelivery or a bounded scan of all abandoned work. That integrated restart/replay
acceptance remains open, along with bounded resume/cancellation semantics and restricted-worker
module startup. `contracts.md` records the recovery port addition for wave reconciliation. L06 remains open.

### Forged delivery jobs, replay and lost webhook completion — 2026-10-04

Added real processor/network acceptance in
`app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts`:

- An organization A envelope referencing B's ready webhook task is rejected as `task_not_found`
  before payload loading, attempt creation or any WireMock request. B's stored state/fencing remain unchanged.
- Replaying the committed envelope after successful delivery is rejected by the terminal task's lease
  eligibility. There is one outbound request, one dispatch attempt and one task-dispatch event receipt.
  The replay currently rejects as `lease_lost`; this proves no repeated delivery, not successful job acknowledgement.
- A real request reaches WireMock successfully, but no completion is written. Expiring the persisted
  sending lease and invoking the processor produces a replacement attempt while preserving the old
  attempt as unknown. Both real requests carry the same immutable task ID in `Idempotency-Key`.

```sh
yarn test:jest \
  app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts
```

Result: **2 suites / 18 tests passed**. Scoped ESLint and diff checking passed; the Jest run type-checked
the affected suites. WireMock's observed header representation is a string, and the final assertions
compare those actual strings. No service method responses were mocked in these scenarios. The existing
suite replaces queue publication only to prevent a second Bull consumer racing direct processor invocation.

This proves stored task ownership for a forged A-context/B-task envelope and a lost-completion delivery
window through real network/persistence adapters. It does not prove receiver-side deduplication (WireMock
records both requests), an actual worker-process crash, Bull stalled-job redelivery, or the complete L09
forged-job/encryption/authority matrix. Those gates, bounded resume and restricted-worker startup remain open.

### Full-module restricted credentials and inherited DI defect — 2026-10-04

Added `app/worker/test/integration/restricted-worker-composition.integration.test.ts`, loading the real
`WorkerModule` without processor/service replacements. Both configured database URLs use the existing
`approvio_worker` login on a disposable clone; superuser setup uses a separate fixture connection.
Redis uses an isolated prefix. Login providers are empty configuration, avoiding unrelated identity
discovery during this worker-only fixture.

The first run failed dispatch admission with PostgreSQL `42501`: `SET ROLE approvio_tenant_runtime`
was denied. `PrismaWorkerTransactionManager` inherited the parent constructor's explicit
`@Inject(DatabaseClient)` metadata. Its worker-typed parameter did not override that injection, so
direct-construction tests had bypassed the real defect. The subclass now explicitly declares
`@Inject(WorkerDatabaseClient)`. Restricted-login dispatch admission succeeds after this one-line fix.

```sh
yarn test:jest \
  app/worker/test/integration/restricted-worker-composition.integration.test.ts \
  app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts \
  app/external/test/database/worker-transaction-manager.integration.test.ts
```

Result: **3 suites / 21 tests passed**; full TypeScript passed. The composition test explicitly records
a remaining defect: expiration's `WorkflowRecalculationService` still uses `TRANSACTION_MANAGER_TOKEN`,
whose tenant client attempts the forbidden tenant role and returns `storage_unavailable`. This is a
transitional negative regression, not successful expiration acceptance; its assertion must become
success when worker role selection and workflow permissions are implemented. The same tenant binding
is used by recalculation and workflow/template loading for status-event task generation.

Worker login membership must remain restricted. Fixing the remaining paths requires reviewing process
composition, shared transaction context and narrowly required workflow/template/vote/group access,
not granting the worker general tenant-role membership. The real full module starts under this fixture's
configuration and dispatch works, but complete restricted-worker execution is not achieved. L06 remains open.

### Shared workflow repositories under worker composition — 2026-10-05

WorkerModule now imports `ServiceModule.forWorker()` and its worker persistence composition. The same
service/repository interfaces and implementations are reused; DI selects `approvio_worker_runtime` for
DatabaseClient rather than adding worker-specific workflow repositories. API composition retains the
tenant role. WorkerDatabaseClient joins this worker datasource's context, so nested dispatch and shared
workflow calls participate in the same transaction. Thread context tracks the runtime role; another
capability starts its own restricted transaction instead of borrowing an ambient API role. Typed tenant
views reject contexts from the other role.

Workflow permissions are now backported into the original security-registry and table-creation
migrations; the standalone workflow capability migration was removed on 2026-10-05. The profiles cover four
tables. It preserves tenant API grants, adds worker SELECT on workflows/templates/votes, limits workflow
UPDATE to status/occ/recalculation_required/updated_at, and allows expiration schedule SELECT/INSERT/UPDATE.
The existing organization predicate and forced RLS remain intact. The profiles are applied when those tables are created;
the API's schema minimum is unchanged. No worker membership in the tenant runtime role was added.

Validation uses the newly created disposable `approvio-adr010-worker-20261005` PostgreSQL 17.4 container,
bound to localhost:55435 with ephemeral data. Existing development and shared test databases were not
modified. Full test changelog replay from empty passed **40 changesets**. A repeated Liquibase update
reported **0 new / 40 previously applied**. `db-migrations/tests/tenant-isolation.sql` passed and rolled
back its fixtures. The first parallel clone run failed because its admin URL connected to the template;
the corrected maintenance URL below avoids holding the template open.

```sh
TENANT_DATABASE_URL=postgresql://postgres@127.0.0.1:55435/postgres \
PLATFORM_DATABASE_URL=postgresql://postgres@127.0.0.1:55435/postgres \
yarn test:jest \
  app/worker/test/integration/restricted-worker-composition.integration.test.ts \
  app/worker/test/integration/workflow-recalculation.processor.integration.test.ts \
  app/worker/test/integration/workflow-expiration-sweep.processor.integration.test.ts \
  app/worker/test/integration/workflow-task-generation.integration.test.ts \
  app/worker/test/integration/workflow-task-generation-slack.integration.test.ts \
  app/worker/test/integration/workflow-actions-webhook.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-email.processor.integration.test.ts \
  app/worker/test/integration/workflow-actions-slack.processor.integration.test.ts
```

Result: **8 suites / 33 tests passed**. With the same maintenance URLs, tenant API workflow/template
integration plus lifecycle and worker transaction suites passed **4 suites / 137 tests**. After the final
role-aware context guards, restricted composition, tenant transaction and dispatch lifecycle suites
passed **3 suites / 24 tests**. These overlapping counts are not additive. Full TypeScript and scoped
ESLint passed. Final `yarn build` passed both backend and worker webpack compilations after the context
guard changes; contract verification and diff checking passed.

The restricted full-module test now asserts successful expiration reads, nested-claim rollback, denied
user reads and denied template/workflow-name mutation. It also proves a worker client inside an API
transaction selects the worker role while the outer API transaction retains its own role. This replaces
the previous transitional expiration-failure assertion.

Full worker acceptance remains open. A live permission audit on this fresh database returned false for
worker SELECT on usage_operations, usage_events and usage_settlement_intents. Metering processors need
their narrow runtime read/reconciliation permissions verified and implemented next. Actual crash/Bull
redelivery, bounded resume/cancellation, the remaining L09 matrix and the integrated backend gate also
remain open. The isolated container is retained for the next acceptance pass, not deployed.

## Restricted usage reconciliation — 2026-10-05

Worker runtime now has tenant-scoped SELECT on usage operations, events and settlement intents,
and UPDATE only on settlement `applied_at`. The backported security profiles preserve existing tenant
and metering grants and is the new worker startup minimum. Full WorkerModule acceptance uses the
restricted worker login, real Bull consumption and Redis recovery: replay preserves a single charge
and acknowledgement; another tenant cannot read or acknowledge the facts; charge creation and amount
updates are denied. Source: `app/worker/test/integration/restricted-worker-composition.integration.test.ts`.

Fresh replay on owned disposable container `approvio-adr010-usage-20261005` (loopback port 55436)
passed **41 test changesets**; repeat applied **0**, and `db-migrations/tests/tenant-isolation.sql`
passed. No shared/development database was changed. Initial focused acceptance passed **5 suites /
52 tests**. A broader run passed eight suites but exposed two API success cases lacking current-period
cache recovery. Their precondition now invokes the real recovery service; a separate test asserts
cold-cache `503 QUOTA_CACHE_UNAVAILABLE`. Final restricted-worker and usage API acceptance passed
**2 suites / 20 tests** using:

```sh
TENANT_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
PLATFORM_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
yarn test:jest app/controllers/test/organization-usage.e2e.test.ts \
  app/worker/test/integration/restricted-worker-composition.integration.test.ts
```

Full TypeScript, scoped ESLint, both backend/worker builds and contract verification passed. Counts
from overlapping runs are not additive. Actual process-crash/Bull redelivery, bounded resume and
cancellation semantics remain open; the cancellation clarification is pending. L06 and broader
backend/adversarial/operations gates remain open. SDK and frontend are excluded.

## Template approval-reference acceptance — 2026-10-05

Template creation and replacement now verify all distinct nested approval-group IDs inside the
caller mutation transaction. The lookup uses the tenant database view and an explicit organization
predicate. Foreign and missing groups produce the same specific service error,
`workflow_template_approval_group_not_found`; create/update controllers preserve it as HTTP 400.
Replacement failure rolls back the old revision's deprecation. Existing status-only deprecation does
not require its historical groups to remain present. Actions contain addresses/URLs, not entity IDs.

Changed boundaries: `app/services/src/workflow-template/interfaces.ts` owns the error contract;
`app/external/src/database/tenant-database-clients.ts` exposes the group delegate to template writes;
`app/external/src/database/workflow-template.repository.ts` performs the lookup during deferred write
execution; `app/controllers/src/workflow-templates/workflow-templates.mappers.ts` maps the reference
error. Repository/API success fixtures now persist their approval groups. New real-adapter tests
cover deletion between preparation and execution, nested foreign references with replacement rollback,
and the exact API error payload. No service calls are mocked for those cases.

Using the owned disposable database on loopback port 55436:

```sh
TENANT_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
PLATFORM_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
yarn test:jest app/main/test/integration/workflows/workflow-templates.integration.test.ts \
  app/external/test/database/workflow-template.repository.integration.test.ts
```

Final result: **2 suites / 72 tests passed**. The earlier API run failed 11 success/duplicate/race tests
because their fixtures referenced random unpersisted groups; after correcting their preconditions,
all 62 existing cases passed, followed by the final 63 API + 9 repository run. Full TypeScript,
scoped ESLint and backend/worker builds passed. This closes the identified L07 template-write gap,
but the same-checkout integrated backend/worker gate and broader L09 matrix remain open. The check
validates references at mutation time; it does not add a foreign key to JSON or prohibit future group
deletion.

## Current-checkout workflow/tenancy regression — 2026-10-05

The integrated slice passed **8 suites / 163 tests** against the owned port-55436 disposable database:
workflow and template API integration; tenant-boundary integration; restricted full WorkerModule;
workflow recalculation, expiration and email/Slack task generation. Command: maintenance tenant and
platform URLs as in the preceding entries, followed by `yarn test:jest` with those eight suite paths.
Full TypeScript, scoped lint and both backend/worker builds passed. This is an integrated slice,
not the complete E1–E6 or F3 gate.

The initial run failed seven tenancy cases. Member mutation tests were taking `.etag` from list items;
current GET-member responses supply the actual header. Tests now fetch that header, validate it, and
retain the original version across stale-version assertions. The invitation acceptance race previously
held an organization row that acceptance no longer locks; it now holds the invitation row and observes
both request queries blocked in PostgreSQL before release. Both changes exercise persisted conditions.
Admission's infrastructure branch also collapsed six distinct errors into misspelled `UNKOWN_ERROR`;
`app/main/src/auth/organization-admission-error.mapper.ts` now preserves each service error code with
HTTP 503. The existing injected dependency-failure case expects its precise `REPOSITORY_DEPENDENCY_ERROR`.
No additional service mocks were introduced. The final full slice passed with successful teardown.

L06 crash/Bull redelivery and bounded resume/cancellation remain open. L07 still requires the remaining
E1/E2/E3/E6 affected suites on this checkout; L09 still requires its complete endpoint/access-class
matrix. SDK/frontend and cross-repository release acceptance remain excluded.

## Remaining API areas and operations scope — 2026-10-05

Current-checkout authentication, organizations, groups, spaces, quotas and organization usage passed
**18 suites / 302 tests** with real adapters on the owned disposable port-55436 database. Exact command:

```sh
TENANT_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
PLATFORM_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
yarn test:jest app/main/test/integration/auth app/main/test/integration/organizations \
  app/main/test/integration/groups app/main/test/integration/spaces \
  app/main/test/integration/quotas app/controllers/test/organization-usage.e2e.test.ts
```

The initial run failed five cases. Invitation storage derives state from `acceptedAt`/`revokedAt`
rather than a persisted status column, and removed/readmitted memberships clear grants to JSON null.
Assertions now check those persisted facts. The template-quota success fixture now creates its approval
group. Concurrent duplicate agent-membership requests may fail through group OCC when both read before
commit, or domain duplicate validation when the later read sees the first commit. The test preserves
both exact conflict codes and requires one successful request, one conflict and exactly one stored
membership; it no longer claims an organization lock it does not exercise. Focused correction acceptance
passed 3 suites / 37 tests before the final 18-suite run. Full TypeScript and scoped ESLint passed.

ADR-001/003/004/006/008/009 now explicitly state ADR-010 amendments for persisted request authority,
tenant audit/actor attribution, scoped audit queries, authenticated encryption context, provider identity
trust and transactional cardinality admission. Historical rationale is identified as such; amendments do
not claim physical purge or completed operational tooling. Contract/link verification and diff checks pass.

User decision: no operator authentication mechanism exists; keep the operator controller/command
entry point unimplemented for now. Existing recovery remains at the service boundary. Authenticated
operational invocation and isolated bootstrap/recovery acceptance remain deferred, so L05 and the
corresponding L11 requirements are not marked complete. No unauthenticated operational endpoint was added.
L06 crash/redelivery and resume/cancellation, the full integrated backend gate and L09 matrix remain open.
SDK/frontend are excluded.

## Complete integration directories and remaining E4 gap — 2026-10-05

The full current backend and worker integration directories passed **47 suites / 640 tests**:

```sh
TENANT_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
PLATFORM_DATABASE_URL=postgresql://postgres@127.0.0.1:55436/postgres \
yarn test:jest app/main/test/integration app/worker/test/integration
```

Database and external test services were real; only owned disposable database clones were mutated.
The initial gate had one failure: the vote-expiry fixture set a deadline before creation. The first
correction also had creation after the fixture's backdated update time. All three dates are now
consistent (creation, past deadline, current update), with rationale in
`app/main/test/integration/workflows/vote-transaction.integration.test.ts`. Final voting acceptance
checks HTTP 422 / WORKFLOW_EXPIRED before quota invocation and confirms no vote persistence. Its
focused suite passed 9 tests, followed by the full 640-test gate. Full TypeScript and scoped ESLint
passed. Global diff checking found one trailing space in an audit mapper TODO; only that space was
removed, preserving the TODO and all surrounding work.

This does not close L07. The source/requirement audit found an explicit E4 mismatch:
`VoteService.castVote` documents optimistic eligibility and no serialization of concurrent membership
or role changes, while `task-E4.md` requires a serialized live authorization point under the organization
and principal/resource locks. Existing tests do not prove the required revocation/vote ordering.
Next work must trace and correct that boundary with deterministic real-database acceptance, rather
than treating the green directories as proof. L06 actual process crash/Bull redelivery and bounded
resume/cancellation, the complete L09 matrix and operational rehearsals also remain open. The operator
entry point remains deferred by user; SDK/frontend remain excluded.

## Consistency check after user scope correction — 2026-10-05

Removed only the rejected strict-authority voting regression and its unused imports. Voting production
behavior was not changed. User retains optimistic voting and defers organization resume/reconciliation;
operator authentication/entry point remains deferred. Prior mandatory E4-fix statements are superseded.

Current verification: full TypeScript passed; backend and worker builds passed; scoped ESLint passed;
contract verification passed (63 API operations and local links); diff checking passed. Full backend and
worker integration directories passed **47 suites / 640 tests** against the owned disposable port-55436
database. Command: maintenance tenant/platform database URLs followed by
`yarn test:jest app/main/test/integration app/worker/test/integration`.

Jest reported one worker needing forced teardown despite all assertions passing. Keep this test cleanup
warning visible; the check does not establish completely clean test-process shutdown. It also does not
claim every service/external/unit suite was rerun or that deferred product features are implemented.
Current implemented backend compiles, builds and passes the exercised integration gate. Broader
adversarial/operations acceptance remains tracked separately from these consistency results.

### Workflow permission backport — 2026-10-05

At the user’s request, workflow worker profiles/grants/policies now live in the original security
registry migration, and the four original table migrations select those profiles. The standalone
workflow-worker capability SQL/YAML and root include were removed. Permission scope is unchanged.

Verified on the owned disposable PostgreSQL container `approvio-adr010-backport-20261005`
(port 55437): all 40 changesets applied; repeat update applied 0 changesets; rollback-only
tenant-isolation acceptance passed; restricted worker composition passed 2 tests. Existing databases
were not modified.

### Usage permission backport — 2026-10-05

Usage reconciliation profiles/grants/policies now live in the original security registry, and the
three original usage-table migrations select those profiles. The standalone usage reconciliation
SQL/YAML and root include were removed. Worker privileges remain SELECT on billing facts and
UPDATE only on settlement `applied_at`; tenant and metering privileges are preserved. API and worker
startup now share the existing minimum migration timestamp.

Verified on the owned disposable PostgreSQL container `approvio-adr010-usage-backport-20261005`
(port 55438): fresh replay applied all 39 changesets; repeat update applied 0; rollback-only tenant
isolation passed; restricted worker composition and runtime schema-version suites passed 6 tests.
TypeScript and scoped lint passed. Existing databases were not modified.
