# D4 handoff — in progress

Converted quota, audit-log and usage-event repository operations to explicit tenant contexts and tenant-leading selectors. Added a durable usage-operation adapter that compares immutable request facts, persists settlement intents transactionally, and exposes pending-operation queries. A source audit on 2026-09-23 found the adapter is not bound in the persistence module and has no service/worker consumer; durable Redis reconciliation is therefore not implemented despite the available repository methods.

Verified on 2026-09-12:

- Scoped ESLint and filtered TypeScript checks pass for `quota.repository.ts`, `audit-log.repository.ts`, `usage-event.repository.ts`, and `usage-operation.repository.ts`.
- `yarn test:jest app/external/test/database/quota.repository.integration.test.ts`: passed; covers tenant-qualified duplicate prevention, deterministic pagination and foreign-organization denial.
- `yarn test:jest app/external/test/database/usage-event.repository.integration.test.ts`: passed; covers immutable actor snapshots, tenant-local aggregation and foreign-organization exclusion.
- `yarn test:jest app/external/test/database/usage-operation.repository.integration.test.ts`: passed; covers same-fact idempotency, immutable-fact mismatch rejection, settlement intent creation/acknowledgement and tenant isolation.
- `yarn test:jest app/external/test/database/audit-log.repository.integration.test.ts`: passed; covers retained actor/entity attribution and cross-organization exclusion.
- Added the append-only platform-security event port and its `approvio_security_runtime` capability. `yarn test:jest app/external/test/database/platform-security-event.repository.integration.test.ts`: passed.
- `git diff --check` passes.

Remaining work: wire idempotent operation-scoped reservation/settlement into the service, publish and
consume `usage.settlement` intents, reconcile/acknowledge Redis failures, then run the broader D4
concurrency suite and Wave D coordinator integration.

`yarn jest --runInBand app/external/test/database`: passed on 2026-09-23 (24 suites, 55 tests), including quota, usage, audit, durable settlement, platform-security and concurrent session-switching coverage.

## Follow-up — 2026-09-23

The usage-operation repository is now registered and used by metering. Admission requires a stable
operation ID and writes its durable request snapshot before Redis admission. Settlement atomically
writes the terminal operation state, immutable usage event, settlement intent and versioned outbox
event. A dedicated worker applies Redis changes idempotently by operation/revision; a bounded periodic
scan retries unapplied intents and acknowledges only after Redis succeeds. Targeted TypeScript and
ESLint checks pass. The repository integration suite currently fails during database preparation with
`AggregateError`, so the new DB/Redis behavior is not runtime-verified. Cache rebuild/admission gating,
broader concurrency/failure acceptance and the Wave D coordinator gate remain open.


## L04 recovery acceptance — 2026-09-28

Implemented recovery in `UsageMeteringService`, `RedisQuotaAdmissionClient`, and the usage-operation
adapter. A cache-local 60-second lease fences rebuilders using Redis time. A RepeatableRead tenant
transaction loads operation facts and their immutable usage events; the service installs totals and
operation replay markers after commit. Missing/busy caches fail closed before a new durable
reservation is written. Reconstructed holds are conservative and retries recheck their effective
limit. A settlement committed after the snapshot is applied by its retained durable intent.

Consumption is assigned by the operation's billing period, rather than the settlement event date.
Rebuild rejects missing/mismatched immutable events and unsafe totals. Operation-derived event and
outbox IDs include the organization, allowing identical operation UUIDs in two tenants without a
global ID collision. Requests larger than the configured limit are rejected before durable insertion.
Ambiguous admission outcomes remain explicit durable holds until settlement/cancellation; recovery
cannot infer whether external work started. There is no automatic cancellation of such operations.

Terminal-only keys retain aggregates and replay markers together until period end plus 90 days;
rebuilding an older period retains it for at least 24 hours. Outstanding reservation units prevent
expiry. Recovery uses the existing tables; no schema migration or production data rewrite was added.
The snapshot covers one tenant/metric/period, including its terminal markers; very large period
ledgers have no streaming rebuild optimization yet.

Changed implementation files:

- `app/services/src/durable-work/interfaces.ts`
- `app/services/src/usage-metering/interfaces.ts`
- `app/services/src/usage-metering/usage-metering.service.ts`
- `app/external/src/database/tenant-database-clients.ts`
- `app/external/src/database/usage-operation.repository.ts`
- `app/external/src/database/usage-event.repository.ts`
- `app/external/src/redis/redis-quota-admission.client.ts`

Acceptance tests in the Redis quota-admission and metering service integration files verify cache
loss with acknowledged consumption and active holds, cancellation/terminal retention, same-ID
cross-tenant settlement, period isolation, stale rebuild fencing, a competing rebuild, incomplete
immutable facts, injected snapshot/install failures, an actual successful Redis reservation whose
reply is lost, and a deterministic settlement committed between snapshot and cache install.
Existing Redis admission concurrency verifies exactly 30 of 50 ten-unit reservations fit a 300-unit
limit. Restricted roles perform application work; fixture setup/corruption alone uses the admin login.

Verification:

- Targeted PostgreSQL/Redis recovery suites: **3 suites, 27 tests passed**.
- A separate empty PostgreSQL 17.4 container, `approvio-adr010-acceptance-20260928`, was created on
  localhost:55433. Restricted logins were provisioned before Liquibase. The complete test changelog
  replayed **41 changesets, zero previously applied**, successfully. The existing Compose database
  was preserved.
- `db-migrations/tests/tenant-isolation.sql` passed on that cluster. The capability-login script's
  assertions passed there using a temporary copy that changes only the container invocation;
  tenant and worker passwords/logins and all SQL assertions remain the same.
- Fresh-cluster adapter/Redis/metering/task-generation/email/webhook acceptance: **30 suites,
  103 tests passed**.
- Full `yarn test:jest` with tenant/platform database URLs pointing at localhost:55433:
  **119 suites, 1,132 tests passed**.
- `yarn build`, `yarn tsc --noEmit`, scoped ESLint, `node docs/adr-010-tasks/verify-contracts.mjs`,
  and `git diff --check` passed.

This closes L04 and the shared fresh-database acceptance blocker for L02/L03. It does not close
L07's service-level JSON-reference mutation gap, the other integration/release gates, or immutable
cross-repository artifact pinning.
