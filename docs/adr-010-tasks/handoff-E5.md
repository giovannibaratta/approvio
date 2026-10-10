# E5 handoff (in progress)

The queue boundary now accepts only a durable `TenantEvent` envelope. The Bull adapter routes by event kind and derives its deduplication key from `(organizationId, eventId)`; it no longer exposes context-free workflow/action publication methods. `QueueService` has the same envelope-only boundary. Recalculation workers reject payloads other than `workflow.recalculate` and take the workflow ID from the envelope resource ID.

The worker now registers a bounded outbox-relay job. Each cycle scans a bounded page of active organizations, claims a bounded batch for each organization, publishes one event at a time, and acknowledges only after Bull accepts it. A publication failure or crash leaves the outbox lease unacknowledged for retry after expiry. Focused relay tests cover successful publication/acknowledgement and failed publication without acknowledgement, but cannot yet run because unrelated E1/E3 callers still fail TypeScript compilation.

An OIDC configuration-reference lookup adapter was added for E1/E5 composition. Its backing `provider_connections.config_reference` is now unique and it resolves only the immutable connection ID, issuer and configuration reference.

Verification so far:

- filtered TypeScript checks pass for the queue adapter, relay, recalculation processor, and provider-connection adapter;
- `yarn test:jest app/external/test/database/provider-connection.repository.integration.test.ts`: passed;
- `yarn jest --runInBand app/external/test/database`: passed on 2026-09-23 (24 suites, 55 tests).

Remaining E5 work: migrate workflow/vote callers to append D3 outbox records, derive worker context from persisted work ownership, and implement lifecycle/fencing/SSRF checks for dispatch processors. The focused relay test cannot yet start because unrelated E1/E3 service callers still omit the newly required tenant context. The old callers still target removed best-effort queue methods, so Wave E is not integrated.

Latest worker-boundary progress:

- `WorkflowRecalculationProcessor` now consumes `WorkflowRecalculation` through `WORKFLOW_RECALCULATION_TOKEN`, rather than the legacy context-free service method. It derives `TenantContext`, workflow ID, and event ID solely from the durable `workflow.recalculate` envelope.
- Email, webhook, and Slack processors now accept only their matching `task.ready` envelopes. Each derives tenant context from the envelope, loads the task through the tenant-scoped repository, claims/fences through `DispatchAdmission`, marks sending before egress, and records the durable outcome. Email and Slack transport failures are `unknown`; webhook HTTP responses are known succeeded/failed outcomes and transport failures are `unknown`.
- `unknown` durable-work outcomes are no longer normally claimable. This prevents an ambiguous email or Slack delivery from being retried as though the remote side had not received it; reconciliation owns any later disposition.
- The webhook client now disables automatic redirects. A redirect is treated as a known HTTP response instead of allowing a checked destination to forward the worker to an unchecked target.
- A focused processor contract test verifies that propagation with a typed E4-port fake. The processor narrows its job input to the Bull fields it consumes, so the test does not fabricate an unsafe complete `Job` object.
- The restricted platform-security capability now exposes its already-migrated `platformSecurityEvent` delegate. The Prisma model and runtime-role INSERT grant were present; this was a missing facade entry discovered while loading the focused test.
- Workflow status events now carry `occurredAt`; the worker rejects malformed actors instead of
  inventing a system actor, and action task metadata records the actual template action index.
- The expiration scheduler now uses the platform-only bounded organization directory scan and
  invokes each tenant sweep with an explicit `TenantContext`; the global repeatable job no longer
  expects an organization ID that Bull never supplied.
- `WorkerModule` now binds `WORKFLOW_RECALCULATION_TOKEN` to the context-aware
  `WorkflowRecalculationService`; `yarn build:worker` passes with the integrated provider graph.
- The durable recalculation port now preserves `WorkflowRecalculationError` rather than collapsing
  repository, encryption, authorization, and transition failures into one misleading error.
- Replaced the stale workflow-task-generation integration fixture that asserted removed plaintext
  task columns with current tenant metadata, encrypted payload, action-index, replay and status
  filtering assertions. The worker status-change processor now opens its required tenant transaction
  before loading the workflow/template. The fixture now re-encrypts template actions with the
  context-bound service, and both focused worker suites pass against the local test services.
- Tenant encryption requires UUIDv7 organization identifiers but accepts any valid UUID for resource
  identifiers because replay-safe task IDs are deterministic UUIDv5 values.

Latest verification:

- filtered TypeScript checks for the recalculation and all three task-dispatch processors pass;
- the focused email processor suite passes against the local database, Redis, and Mailpit services;
- the focused task-generation, email, webhook, and Slack processor suites pass (12 tests total)
  against the local test database, Redis, Mailpit, and WireMock services;
- the expiration-sweep, queue-serialization, and Slack task-generation suites pass (6 additional
  tests). Expiration reads now execute inside the tenant transaction manager, and queue tests use
  the serialized `TenantEvent` envelope with `resourceId` rather than legacy workflow fields;
- `yarn build:worker` passes.
- The shared authenticated-user test fixture now creates the provider connection and selected browser
  session required by the current JWT contract. `JwtStrategy` resolves the selected membership under
  an explicit tenant transaction. This unblocked the spaces suite from its previous blanket
  `JWT_UNKNOWN_ERROR`; remaining spaces failures are tracked as main-integration migration work.
- The Agents API suite (16 tests), agent-role suite (32 tests), and agent-auth suite (20 tests) now
  pass against the local database and Redis. Agent registration, lookup, challenge exchange, and
  refresh rotation execute under explicit tenant transactions; agent role scopes retain their
  organization binding, and refresh-family revocation commits before returning reuse detection.
- The full backend TypeScript check now passes. A broad runtime rerun exposed remaining stale
  workflow/template route fixtures and quota read/update/delete persistence-boundary failures;
  quota creation is now transaction-bound and passes. These runtime failures remain open.


## Current L06 reconciliation (2026-09-28)

The preceding checkpoints are historical. [L06-acceptance.md](L06-acceptance.md) owns current source
findings and the acceptance matrix. Service-owned post-commit task publishing and real relay
fairness/failure/crash recovery pass 5 suites / 14 tests on the fresh 43-changeset cluster. Lifecycle
admission/send rechecks, dispatch concurrency/lease renewal and bounded resume reconciliation remain
implementation gaps. E5/L06 stays open; older green processor suites do not prove those controls.

The subsequent full regression run passed **125 suites / 1,173 tests** on the same cluster. Backend
and worker builds, TypeScript, scoped lint, contract verification and diff checks passed. This closes
regressions in the publishing change only; the implementation gaps above keep the task open.


### Locked admission follow-up (2026-09-28)

Task dispatch now locks organization metadata and enforces active status at claim and immediately before
sending through the restricted worker transaction. Four lifecycle/processor suites / 16 tests pass,
including actual worker-login metadata isolation and a deterministic suspension race. In-flight
completion after suspension remains allowed. All 44 changesets replayed from empty on the new owned
PostgreSQL cluster at localhost:55435; tenant-isolation SQL and real login checks pass. Backend/worker
builds pass. The first full fresh-cluster run passed 1,183 assertions but five suite cleanup hooks timed
out. Bounded reruns were interrupted and supplied no result. The complete regression gate remains open.
Parking/resume, cap/renewal, database retries and actual restricted-login worker module acceptance remain
under L06. [Current evidence and implementation gaps](L06-acceptance.md).


Durable parking follow-up: inactive ready work and admitted-before-send work now pause transactionally.
All three processors acknowledge parked results without egress; the unsent attempt closes with
`organization_paused`. Focused real PostgreSQL/Redis acceptance passes 2 suites / 7 tests, including
duplicate email job acknowledgement with no send (5 unrelated email tests skipped). Owned database
runtime recovery and isolated Redis were required; OIDC discovery is disabled only for these dispatch
slice modules. Resume/expiry, cap/renewal and broad regression remain open.
