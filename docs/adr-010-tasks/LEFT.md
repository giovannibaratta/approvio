# ADR-010 work left

This is the active completion ledger. A handoff records what an individual task produced; it does not close a wave. Keep an item open until its implementation and required acceptance evidence are recorded here. `CURRENT-STATUS.md` summarizes the resulting state. Do not infer a pass from an older handoff or a type check.

Updated: 2026-09-28. Baseline: backend branch `multi-org-support` at `0a9791f`, with extensive staged and unstaged ADR-010 changes. Existing work must be preserved. The linked API, frontend, and CLI are separate checkouts; their current branches and tests have not been verified here.

## Current execution scope — 2026-10-04

Backend work is active again by user request. Start with L06 worker acceptance, then L07/L09 and the
backend operations portions of L11/L12. The operator boundary (L05) is also reopened after source reconciliation. SDK and frontend work are excluded for this pass; their
acceptance and the full cross-repository release gate remain open. Preserve the shared dirty worktree.

The frozen dispatch requirements already select a configurable per-organization cap of four, lease
renewal, fail-closed Redis admission, and expiry checks before resumed dispatch. No product decision
blocks an initial source/acceptance reconciliation. Broader API/worker DI wiring needs a concrete
consumer/grant/transaction inventory before proposing structural changes; the shared organization-status
contract refactor does not establish process-specific client selection.

Latest focused validation covers branded durable-work factories, exact usage error propagation,
repository mapping, dispatch lifecycle, outbox relay, and cache recovery: 11 suites / 146 tests passed.
Full TypeScript checking, scoped ESLint, and diff checking passed. This is partial evidence and closes
none of the remaining worker or integrated-backend gates; see the dated L06 acceptance entry.

## Working rule

For each item: record the owning task, exact changed files or artifact SHAs, the command and result that exercises the required boundary, and any remaining limitation. Mark it complete only when the owning task acceptance and relevant wave gate pass. If a check cannot run, record the cause and leave the item open. Resolve contract drift in `contracts.md` and the owning handoff before marking an item complete.

## Frozen contract and backend implementation

- [ ] **L05 — E2/F4 operator boundary (reopened 2026-10-04; entry point deferred by user 2026-10-05).** The previous completion claim is contradicted by the current source: `OperatorRecoveryService` requires its caller to authenticate the operator, but no operator module, authentication/command adapter, executable entry point, or operator acceptance suite was found. Its linked completion handoff is absent. Implement and verify authenticated, scoped operational invocation and atomic/idempotent bootstrap/recovery before closing this item. The earlier 125-suite / 1,170-test report is historical and cannot establish current completion. Sources: `task-F4.md`, `handoff-E2.md`.
- [ ] **L06 — E5 worker acceptance.** Reconcile the older `handoff-E5.md` claims with the current worker code, then verify persisted ownership, dispatch fencing, lifecycle parking/resume, unknown outcomes, SSRF/redirect controls, outbox replay, and fair bounded publication with real adapters. Sources: `task-E5.md`, `handoff-E5.md`.
- [ ] **L07 — E1–E6 integrated backend gate.** After implementation fixes, verify backend and worker builds, DI/module startup, affected unit and real-adapter integration suites, and contract validation on the same checkout. Validate JSON approval/action reference existence and organization ownership in the template mutation transaction (E3 gap found during D2 review). Record the exact commands, test counts, and failures. The 2026-09-23 pass in `CURRENT-STATUS.md` predates current uncommitted changes. Source: `wave-E.md`.

## API, clients, and acceptance

- [ ] **L08 — API/SDK contract.** The linked `approvio-api` OpenAPI source already declares member/invitation operations, member `ETag`/`If-Match`, and organization-qualified entitlements/usage paths. Verify generated validators and SDK exports against the backend routes, run API build/lint/tests, and pin a reviewed source SHA and generated artifact/version. Do not repeat the stale source-addition instruction in `PENDING.md`. Sources: `handoff-B3.md`, `handoff-E2.md`, `E6-plan-review.md`.
- [ ] **L09 — F3 adversarial boundary matrix.** Execute restricted-role/RLS and repository-access-class checks, deterministic authority/context/vote/quota races, forged tenant jobs, replay/outbox/lifecycle cases, encryption substitution, and platform-metadata isolation. Keep fixture superuser setup separate from runtime-role assertions. Sources: `task-F3.md`, `handoff-F3.md`.
- [ ] **L10 — F1/F2 clients.** Complete frontend onboarding/organization switching and CLI organization selection against the pinned API/SDK; verify stale-session behavior, tenant-prefixed cache/query keys, and cross-org request rejection. Sources: `task-F1.md`, `task-F2.md`.
- [ ] **L11 — F4 operations and ADR alignment.** Finish setup/recovery, fresh-install, cutover and rollback guidance; verify role grants and repeat bootstrap in an isolated environment. Reconcile conflicting older ADR statements. Do not rewrite already-applied Liquibase changesets without proving the target is disposable. Sources: `task-F4.md`, `PENDING.md`.
- [ ] **L12 — G1 release gate.** Pin all repository SHAs and package versions; rehearse empty install and an explicitly disposable pre-tenancy cutover, credential/job invalidation, two-org browser/CLI/agent flows, restart/outbox recovery, rollback/forward repair, and performance/fairness checks. Publishing, deployment, merging, and destructive reset remain outside this ledger's authorization. Source: `task-G1.md`.

## Completed items

- **L02 — D2 resource adapters:** selector/link/rollback and crypto-boundary acceptance passed, followed by the fresh-cluster coordinator checks below. [D2 evidence](handoff-D2.md).
- **L03 — D3 receipts and leases:** real receipt/replay/rollback and expired/reclaimed-lease fencing passed, followed by the fresh-cluster coordinator checks. [D3 evidence](handoff-D3.md).
- **L04 — D4/E6 metering recovery:** durable-snapshot cache rebuild, admission gating, conservative holds, scoped replay identities and terminal-key retention implemented. Fresh-cluster acceptance passed 30 suites / 103 tests, then the full suite passed 119 suites / 1,132 tests. [D4 evidence and limits](handoff-D4.md).

- **L01 — E1 request authority:** implemented current-authority/lifecycle admission and transactional sensitive-write rechecks. Removed from the open list after 119 suites / 1,117 tests passed, followed by 92 group integration tests for the final lookup adjustment; backend/worker build, TypeScript, scoped lint, contract and diff checks passed. [Implementation and acceptance evidence](handoff-L01-authority-20260927.md). Remaining broad wave and release gates stay open.

## Evidence recorded in this pass

- Before L01 implementation, source inspection confirmed: `AuthorityResolver` appears only as a declaration in the backend, and `TenantPrincipalFactory` has no application caller. This is implementation evidence, not a runtime test.
- The current backend `yarn tsc --noEmit --pretty false`, `yarn build`, `node docs/adr-010-tasks/verify-contracts.mjs`, and `git diff --check` passed on 2026-09-27. Build and type checks alone do not close ledger items.
- After the removed-membership admission fix, `yarn test:jest app/services/test/auth/jwt-principal.service.test.ts` passed (1 suite, 4 tests); TypeScript and scoped ESLint passed. This earlier result preceded the L01 acceptance tests recorded above.
- The local test-profile setup provisioned PostgreSQL and applied Liquibase migrations. `yarn test:jest app/main/test/integration/quotas/quotas.integration.test.ts -t 'different organization target'` passed against the prepared test database (1 test; 11 skipped). This verifies the earlier list-filter simplification, not the remaining ADR gates.
- `yarn test:jest app/main/test/integration/tenancy/tenant-boundary.integration.test.ts` passed (17 tests) and `yarn test:jest app/main/test/integration/auth/auth.integration.test.ts` passed (24 tests) on 2026-09-27. Neither suite exercises the missing operation-aware authority resolver or transactional recheck.
- **L00 closed:** corrected all eight failures from the first full Jest run. The final `yarn test:jest` run passed **119 suites and 1,110 tests** on the prepared local test profile. The fixes and commands are recorded in [the reconciliation handoff](handoff-reconciliation-20260927.md). This closes the observed runtime regressions; it does not prove missing ADR acceptance scenarios.
- Read-only inspection of `/workspace/approvio-api/openapi.yaml` at `6a7b8c2` found the L08 paths, and its member mutation schema declares `If-Match` and response `ETag`. The API checkout has unrelated uncommitted auth changes. Generated artifact and tests remain unverified.
- The initial `PENDING.md` and `CURRENT-STATUS.md` inspection left L02–L05 and L08–L12 open; L02–L05 have since closed with the evidence above. The existing E5 handoff includes intermediate failures and needs revalidation against the current worker before L06 can close.
- Fresh PostgreSQL/Redis acceptance is now recorded in the D4 handoff: 41 changesets replayed from empty, restricted-role SQL/login checks passed, 30 focused suites / 103 tests and 119 full suites / 1,132 tests passed. Cross-repository acceptance remains open.

- L06 publishing/relay acceptance now passes 5 suites / 14 tests, including real Bull/Redis relay fairness and crash recovery. Task publishing is service-owned after commit. Dispatch lifecycle, lease/cap and resume implementation gaps keep L06 open. [Current evidence](L06-acceptance.md).

- L06 locked claim/send admission and post-suspension in-flight settlement pass 4 suites / 16 tests.
  A fresh owned cluster replays all 44 changesets and passes RLS/login checks. The full run passed all
  1,183 assertions but five suites failed cleanup hooks; interrupted bounded reruns provide no result.
  L06 remains open for parking/resume, cap/renewal, collision retries and restricted worker credentials.


- On 2026-10-04, restricted-worker whole-transaction collision retries passed 5 suites / 25 tests;
  final acknowledgement mapping and business-error non-retry checks passed 3 suites / 15 tests.
  Real Serializable collisions exercise fresh snapshots, retry exhaustion, and nested dispatch rollback.
  L06 remains open for cap/renewal, bounded resume/expiry semantics and full restricted-worker wiring.
  [Exact commands, changed files and scope](L06-acceptance.md#worker-transaction-collision-retries--2026-10-04).

- The 2026-10-04 backend/worker build passed. Contract verification passed after resolving five dead
  evidence/documentation links and reopening the source-contradicted L05 operator boundary. Full
  TypeScript and diff checks passed. These static gates do not replace the missing operator runtime acceptance.

- On 2026-10-04, dispatch capacity/renewal adapter acceptance passed 3 suites / 18 tests, with real
  Redis concurrency and stale-owner checks plus database renewal under persisted ownership and expiry.
  Full TypeScript and scoped lint passed. Processor integration, heartbeat/cleanup and recovery of
  in-flight capacity after Redis state loss remain open; this does not close L06.
  [Scope and evidence](L06-acceptance.md#dispatch-capacity-and-renewal-adapters--2026-10-04).

- Dispatch capacity is now connected to email, Slack and webhook execution, with immediate pre-egress
  checks, periodic Redis/database renewal and capacity cleanup. Current acceptance: 7 suites / 36 tests
  and full TypeScript passed. In-flight occupancy recovery after Redis state loss, bounded resume and
  restricted-worker module wiring remain open.
  [Commands and coverage](L06-acceptance.md#delivery-capacity-lifecycle-integration--2026-10-04).

- The durable dispatch guard now enforces the configured cap under a Serializable transaction even
  after Redis slot state disappears. Two-org saturation and a forced different-task admission race
  pass with the seven-suite worker command: 37 tests, full TypeScript, scoped lint and diff checks.
  Expired claimed/sending restart recovery, bounded resume and full restricted-worker startup remain open.
  [Evidence and retry-budget limitation](L06-acceptance.md#durable-capacity-guard-after-redis-loss--2026-10-04).

- Expired ownership recovery is now task-scoped in admission: abandoned pre-send claims become
  retryable; abandoned sending becomes unknown, preventing automatic email/Slack replay. Webhook
  replacements remain fenced and are blocked during suspension. Acceptance passed 7 suites / 41 tests,
  followed by the final lifecycle suite / 12 tests, scoped lint, contract and diff checks.
  Actual crash/Bull-redelivery acceptance, bounded resume and restricted-worker startup remain open.
  [Commands and coverage](L06-acceptance.md#expired-dispatch-ownership-recovery--2026-10-04).

- Forged A-context/B-task webhook envelopes cause no network request or database attempt. Completed
  event replay sends once, and a real accepted webhook with missing completion retries under the same
  immutable idempotency key. Processor/lifecycle acceptance passed 2 suites / 18 tests, scoped lint and
  diff checks. This contributes to L06/L09 without proving actual process crash or Bull redelivery.
  [Real-adapter evidence and limits](L06-acceptance.md#forged-delivery-jobs-replay-and-lost-webhook-completion--2026-10-04).

- Full WorkerModule acceptance under the restricted worker login exposed inherited Nest injection
  metadata selecting the tenant client for its worker transaction manager. Explicit worker injection
  now fixes dispatch admission; 3 suites / 21 tests and full TypeScript pass. Expiration still attempts
  the forbidden tenant role, recorded by a transitional negative regression. Recalculation/task-generation
  wiring and narrow workflow permissions still need implementation.
  [Runtime evidence and remaining composition boundary](L06-acceptance.md#full-module-restricted-credentials-and-inherited-di-defect--2026-10-04).

- On 2026-10-05, worker composition now selects the worker role for shared workflow repositories and
  shares nested dispatch transactions without borrowing API privileges. A new tracked migration was
  replayed from empty (40 test changesets), repeated with no changes, and passed tenant-isolation SQL.
  Worker processors passed 8 suites / 33 tests; API/transaction regression passed 4 suites / 137 tests;
  final role-context checks passed 3 suites / 24 tests. TypeScript and scoped lint pass. Metering worker
  permissions, actual crash/Bull redelivery, bounded resume and the full backend/adversarial gates remain open.
  [Commands, changed boundaries and remaining permission gap](L06-acceptance.md#shared-workflow-repositories-under-worker-composition--2026-10-05).

- Restricted worker usage reconciliation is implemented through the original security and usage-table migrations: tenant
  reads and settlement acknowledgement only. Fresh replay passed 41 changesets, repeat applied zero,
  and RLS acceptance passed. Real Bull/Redis reconciliation and API cache preconditions passed final
  2 suites / 20 tests; TypeScript, scoped lint, builds and contract verification passed. L06 remains
  open for actual crash/redelivery and bounded resume/cancellation; broader backend gates remain open.
  [Evidence and limitations](L06-acceptance.md#restricted-usage-reconciliation--2026-10-05).

- L07 reference validation was traced on 2026-10-05. `ApprovalRule.getVotingGroupIds()` already
  enumerates nested group references; action variants contain addresses/URLs and no tenant entity IDs.
  `WorkflowTemplateDbRepository.createPreparedTemplate` and `updatePreparedTemplate` persist JSON
  without checking groups, and `WorkflowTemplateTenantClient` exposes only templates. Existing real
  repository acceptance passed 7 tests on the owned port-55436 database even though its helper uses
  unpersisted random group IDs. This is evidence of the gap, not reference-validation acceptance.
  Next change: check tenant-scoped groups inside deferred writes, propagate a distinct reference error,
  and replace successful fixtures with persisted groups; cover missing/foreign groups and atomic
  replacement rollback. L07 remains open. Baseline command: maintenance database URLs plus
  `yarn test:jest app/external/test/database/workflow-template.repository.integration.test.ts`.

L07 implementation update (2026-10-05): deferred template creation now counts distinct approval-group
IDs through the tenant-scoped database view inside the mutation transaction. This includes replacement
creation, so invalid new references roll back the preceding deprecation. Missing and foreign groups
return the service-owned `workflow_template_approval_group_not_found`; create/update HTTP mapping
preserves that code as a bad request. Deprecation alone does not revalidate existing references.
Repository acceptance passed **1 suite / 9 tests**, including group deletion after preparation and
nested cross-tenant replacement rollback, on the owned port-55436 database. Full TypeScript and scoped
ESLint passed. API fixture/regression acceptance is still in progress; this does not close L07.

- L07's JSON approval-group validation gap is implemented. Deferred creation/replacement checks
  tenant-owned groups in its mutation transaction, with a specific HTTP error and atomic rollback.
  Real API/repository acceptance passed 2 suites / 72 tests; full TypeScript, scoped lint and both builds
  passed. The integrated L07 gate and broader L09 matrix remain open.
  [Evidence and mutation-time scope](L06-acceptance.md#template-approval-reference-acceptance--2026-10-05).

- Current-checkout workflow/tenancy and restricted-worker regression passed 8 suites / 163 tests.
  Stale list-item ETag fixtures and the obsolete invitation race lock were corrected using actual
  GET headers and an observable database barrier. Admission now preserves distinct dependency errors.
  TypeScript, scoped lint and both builds passed. Remaining E1/E2/E3/E6 and full F3 acceptance stay open.
  [Evidence](L06-acceptance.md#current-checkout-workflowtenancy-regression--2026-10-05).

Current F3 adversarial slice passed 6 suites / 55 tests on 2026-10-05: persisted session authority,
receipt/outbox replay, append-only platform events, encryption binding and dispatch ownership.
[Coverage and explicit gaps](F3-current-coverage.md) record the requirement attribution. L09 remains open;
these results do not establish every endpoint/access class or actual crash/redelivery/resume.

- Remaining authentication/organization/group/space/quota/usage API regression passed 18 suites /
  302 tests. Updated invitation persisted-state assertions, quota approval-group preconditions and
  the concurrent membership invariant. TypeScript and scoped lint pass. ADR-001/003/004/006/008/009
  explicitly record ADR-010 amendments. Operator authentication/entry point is deferred by user:
  recovery remains at the service boundary, with no controller added; L05/L11 acceptance stays open.
  [Evidence and scope decision](L06-acceptance.md#remaining-api-areas-and-operations-scope--2026-10-05).

- Full backend/worker integration directories passed 47 suites / 640 tests, with consistent expired-vote
  preconditions; TypeScript and scoped lint pass. L07 remains open: source audit found E4's live-vote
  serialization requirement is contradicted by the optimistic implementation in `VoteService.castVote`.
  Deterministic revocation/vote ordering must be implemented and proven. Other lifecycle/adversarial/
  operations gaps remain open. [Evidence](L06-acceptance.md#complete-integration-directories-and-remaining-e4-gap--2026-10-05).

E4 live-role gap is now reproduced against real adapters: a JWT principal resolved before committed
role revocation still persists one vote. The new regression intentionally fails (expected zero votes,
observed one); the current gate is red, and the prior 640-test green run predates it. No mocks were
introduced for the reproduction. [Boundary inventory and correction plan](E4-vote-authorization-plan.md)
record the affected ports and required deterministic acceptance. L07/L09 remain open.

## User scope correction — 2026-10-05

Existing optimistic voting is explicitly retained. The proposed E4 authority change and its failing
regression are withdrawn; earlier entries calling it a required fix are historical and superseded.
Organization resume/reconciliation and related abort/expiry semantics are deferred for later, as is
the previously deferred authenticated operator entry point. These deferred features are not current
consistency blockers. Existing implementation and acceptance limits remain documented separately.

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
