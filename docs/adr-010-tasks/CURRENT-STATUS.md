# ADR-010 current status

Updated: 2026-10-05. This is a handoff-status report, not a Wave completion claim. Track each open implementation and acceptance item in [LEFT.md](LEFT.md); older pass counts below describe the checkout at the stated date, not the current dirty worktree.

Backend ledger work resumed on 2026-10-04 by user request. SDK and frontend work are excluded from
this pass. L06 remains the first implementation/acceptance target; bounded resume, dispatch cap/renewal,
and full restricted-worker wiring still need current evidence. Worker transaction collision retries
now have real-adapter evidence (5 suites / 25 tests; final follow-up 3 suites / 15 tests), including
retry exhaustion, nested dispatch rollback, and business-error non-retry. Resume semantics now require clarification about work aborted during suspension; broad DI changes
require a concrete proposal first. Independent acceptance and retry work can continue.

Dispatch capacity/renewal adapters now pass 3 suites / 18 tests, full TypeScript and scoped lint.
Redis enforces organization-scoped slots and fenced ownership; database renewal rejects expired or
replaced ownership. Processor integration now passes 7 suites / 36 tests and full TypeScript, including
capacity rejection before database admission, heartbeat renewal, cleanup and immediate pre-egress
checks. A subsequent durable live-lease guard now passes 7 suites / 37 tests, full TypeScript and scoped
lint: Serializable count/claim prevents over-cap admission after Redis slot loss, and another organization
progresses while the first is saturated. Expired claimed/sending ownership recovery is now implemented
when a job reaches admission: pre-send claims can retry; abandoned sending becomes unknown, with
email/Slack replay parked and webhook replacement blocked during suspension. Acceptance passed
7 suites / 41 tests, then the final lifecycle suite / 12 tests. Actual process-crash/Bull-redelivery
acceptance remains open. The live-lease guard cannot recall external calls that outlive their leases.
L06 remains open.

Latest processor/network acceptance passes 2 suites / 18 tests: forged A-context/B-task webhook jobs
produce no request or attempt; completed event replay does not redeliver; a real accepted webhook whose
completion was lost retries with the same immutable idempotency key. Scoped lint and diff checks pass.
This does not establish an actual process crash, Bull redelivery or receiver-side deduplication.

Full WorkerModule now starts under restricted worker credentials in an isolated fixture. An inherited
Nest constructor injection defect was reproduced and fixed by explicitly injecting WorkerDatabaseClient
into PrismaWorkerTransactionManager. Dispatch admission then succeeds; 3 suites / 21 tests and full
TypeScript pass. Expiration still fails on the forbidden tenant runtime role, explicitly recorded as a
transitional negative regression. Full restricted-worker processor execution remains open.

On 2026-10-05, the expiration defect is replaced by positive acceptance. Worker DI now selects the worker
role for shared workflow repositories, and nested dispatch participates in their transaction. Role-aware
contexts prevent borrowing API privileges. The new tracked workflow-capability migration replayed from
empty (40 test changesets), repeated with zero changes, and passed tenant-isolation SQL. Worker processor
acceptance passed 8 suites / 33 tests; API/transaction checks passed 4 suites / 137 tests; final role guards
passed 3 suites / 24 tests. TypeScript and scoped lint pass. The subsequent usage-reconciliation migration and acceptance below resolve the three-table permission
gap; full worker, crash/redelivery, resume and broader backend gates stay open.

The latest focused durable-work model and boundary validation passed 11 suites / 146 tests, full
TypeScript checking, scoped ESLint, and diff checking. This result does not prove the outstanding
worker slices or an integrated backend gate. Older full-regression results below remain historical.

Latest complete backend regression: **125 Jest suites and 1,173 tests pass** on disposable clones of a separate
fresh PostgreSQL 17.4 cluster after service-owned task publishing and relay acceptance. All 43 Liquibase changesets replayed
from empty on localhost:55434;
tenant-isolation SQL and real capability-login assertions pass. Backend/worker builds, TypeScript,
scoped lint, contract verification, and diff checks pass. L02–L04 remain recorded complete; L05 has been reopened after current-source reconciliation; remaining ledger
items and cross-repository/release barriers stay open. [Latest commands and evidence](L06-acceptance.md).

| Wave | Recorded state                                                              | What still prevents the barrier                                                                                                                                              |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Complete                                                                    | Nothing recorded.                                                                                                                                                            |
| B    | Complete, intermediate breaking branch                                      | Fresh-cluster changelog and tenant-isolation SQL passed; integrated wave barrier remains.                                                                                    |
| C    | C1-C3 implemented; C1 fresh-cluster acceptance rerun passed                 | Current snapshot is recorded; immutable artifact pinning and a clean integrated Wave C gate remain open. Later E composition and integrated barriers remain separately open. |
| D/E  | Core backend paths integrated; E2 tooling and E6 backend implemented        | Worker acceptance, JSON-reference mutation validation, API/SDK artifact verification, and prior-wave integration evidence remain. |
| F/G  | F3 initial tenant-boundary slice implemented; cross-repository work remains | F3's broad matrix, F4 operator tooling, F1/F2 frontend and CLI work, and G1 remain.                                                                                          |

## Missing work from prior waves

- **Reconciliation (2026-09-16):** the repository still has a coordinated local integration state,
  not completed waves. The linked `@approvio/api` package was regenerated from its current OpenAPI
  source. Backend controller paths now pass explicit tenant context for groups, spaces, resources and
  workflow templates. The users, workflow-template, quota, space, group-membership, workflow and vote
  service source paths now type-check; focused lint also passes for those seams. Durable workflow
  recalculation now emits the current `TenantEvent` contract, including actor and occurrence time;
  workflow task metadata preserves the actual action index. The expiration scheduler pages
  organizations through the platform-only directory capability before invoking each tenant-scoped
  sweep. The shared test fixture now creates current platform-account and local-user rows instead
  of removed email/admin/identity rows. The backend type check now passes after migrating the
  remaining direct Prisma fixtures and removed API contracts. No wave completion claim is made from
  this partial work.

- **C1:** fresh-cluster changelog, B1 tenant-isolation SQL, transaction-manager/capability tests, TypeScript, and scoped lint passed on 2026-09-23. The C1 handoff records commands and scope. The current Wave C repository/artifact snapshot is recorded in [the manifest](integration-manifest-wave-C.md); immutable artifact pinning and the integrated Wave C gate remain open.
- **D1:** the acceptance scenarios now have integration evidence for shared-account discovery,
  invitation acceptance, last-owner protection, refresh-family reuse, historical voter retention, and
  concurrent organization creation, invitation acceptance, and session switching. D1 remains behind
  the Wave D coordinator gate.
- **D2 (2026-09-28):** current selector/link/include/list/count/bulk and rollback evidence is
  mapped in [D2-acceptance.md](D2-acceptance.md). Template crypto runs outside retry closures.
  The expanded adapter folder passes (26 suites, 69 tests); restricted-role SQL and capability
  login checks pass on the prepared profile. The fresh-database coordinator acceptance below closes L02.
- **D3 (2026-09-28):** receipt/replay/transaction rollback and integrated TaskService expired/reclaimed
  lease fencing pass against PostgreSQL (29 combined adapter/worker suites, 82 tests). The final
  task-generation suite passes 5 tests, including exactly one receipt/task-ready event on concurrent
  replay. The fresh-database coordinator acceptance below closes L03.
- **D4 (2026-09-28):** durable usage recovery, admission gating, fenced snapshot installation,
  organization-scoped replay identities and safe terminal-key retention are implemented. Cache-loss,
  snapshot/settlement race, cross-tenant replay and injected failures pass against PostgreSQL/Redis.
  A separate empty PostgreSQL 17.4 cluster replayed all 41 changesets; restricted-role SQL/login
  assertions passed. Fresh acceptance passed 30 suites / 103 tests; the full suite passed
  119 suites / 1,132 tests. Backend/worker build, TypeScript, scoped lint, contract and diff checks
  passed. [D4 evidence and recovery limits](handoff-D4.md). L02–L04 are removed from the open ledger;
  the broader L07 service/integration and release gates remain open.

## Remaining implementation

- **L06 in progress (2026-09-28):** task event publishing now runs in `TaskService` after commit,
  best effort, with durable fallback. Five affected suites / 14 tests pass, including actual
  Bull/Redis relay fairness and acknowledgement-crash recovery. Worker transactions are implemented.
  Dispatch now uses read-only status checks and accepts a race with uncommitted suspension. The prior
  strict-lock version passed 4 suites / 16 tests; those results, the earlier database replay, and the
  full regression predate this change. The latest full regression passed all 1,183 assertions but five
  suites timed out in cleanup; bounded-concurrency rerun is pending. Durable parking passed 2 focused
  suites / 7 tests after recovery of the owned database and use of isolated Redis (5 unrelated email
  tests skipped; OIDC discovery disabled in this dispatch-only slice). This status-read change remains
  unvalidated. Bounded resume, cap/renewal and restricted-worker module acceptance remain open.
  [Current worker evidence](L06-acceptance.md).

- **L05 reopened (2026-10-04):** the previous completion report is not supported by the current tree.
  Only `OperatorRecoveryService` was found; it explicitly delegates operator authentication to its caller.
  The claimed module, operational command adapter/entry point, acceptance suite and linked handoff are
  absent. L05 is open again; [the operator task](task-F4.md) remains the acceptance specification.

- **E1 authority (2026-09-27):** L01 is implemented and removed from the open ledger. Current
  membership/session/agent and lifecycle admission is wired globally; sensitive writes reload
  authority under the organization lock. Committed revocation, suspension, stale context, storage
  failure and a deterministic concurrent role-demotion check have real-adapter evidence in the
  [L01 handoff](handoff-L01-authority-20260927.md). This does not close the broader integrated or
  cross-repository acceptance gates.
- **E2:** platform-only `GET /organizations` discovery and atomic `POST /organizations` creation are
  wired. Tenant member listing, role change/removal, invitation create/revoke/accept, organization
  summary/update/lifecycle, and internal audited operator recovery service paths now use tenant
  transactions. Membership role changes and removals use Serializable transactions with whole-transaction
  retries to enforce the active-owner invariant. Invitation acceptance is bound to a platform session and exact account. The operator
  service has no public entry point; its independently authenticated CLI boundary and recovery
  acceptance are complete under L05. Linked API artifact validation and the broader F3 matrix
  remain pending; organization discovery/provisioning/lifecycle
  acceptance is covered by the tenant-boundary HTTP suite. See the [pickup queue](PENDING.md).
- **E6:** backend entitlements and usage use `/o/:organizationId/...` and resolve plan tier from
  tenant-scoped `organizations.plan_tier`. Provisioning assigns a fixed initial tier by deployment
  mode (`FREE` for SaaS, `SELF_HOSTED_UNLIMITED` for self-hosted). Tier reads
  are restricted and tenant-scoped, and quota/usage perform them before external cache operations.
  The linked API OpenAPI source already has the organization-qualified paths; generated artifact
  validation and pinning remain open. See
  [E6-plan-review.md](E6-plan-review.md).
- **F4:** operator bootstrap/recovery executable and repeat-bootstrap/recovery acceptance are complete
  under L05. Deployment packaging, fresh-install/cutover/rollback rehearsal and operations guidance
  remain under L11.
- **Cross-repository:** F1 frontend onboarding/switching, F2 CLI organization selection, and G1 release
  integration are outside this backend repository and remain open.
- **Validation (2026-09-23):** before the D3 receipt follow-up, `yarn tsc --noEmit`, `yarn build`, scoped ESLint on changed files,
  `git diff --check`, and the contract verifier passed. The full Jest suite passed 109 suites and
  1,064 tests on disposable clones of the fresh PostgreSQL 17 cluster; external database suites
  passed 24 suites and 56 tests on the same fresh-cluster template.
  The full Liquibase changelog applied all 39 changesets to a fresh PostgreSQL 17 cluster after
  provisioning only the documented external login roles. The plan-tier column and organization RLS
  registration/policies were verified in the migrated database. The tenant-isolation acceptance SQL
  passed against that cluster and rolled back its fixtures. Prisma was previously introspected from
  the disposable integration schema and regenerated.
  The implementation-related reruns also pass, including duplicate-space constraint mapping and
  tenant-context quota/usage paths. The tenant-boundary integration suite now passes with last-owner,
  deterministic owner-race, stale-ETag, membership-cleanup/rollback, and invitation-boundary cases
  (16 tests). The broader adversarial
  acceptance matrix remains open.

- **D3 receipt follow-up (2026-09-23):** tenant receipt schema, restricted adapters, transactional
  recalculation/task-generation integration, replay/rollback test cases, and a reclaimed-lease test are
  now in the worktree. `yarn tsc --noEmit`, scoped ESLint, `git diff --check`, and the contract verifier
  pass. Focused receipt and workflow-task-generation Jest suites cannot prepare their disposable
  database (`AggregateError`); starting the dev database fails because Podman cannot create its user
  namespace. No database volumes were removed. PostgreSQL runtime verification and the Wave D gate are
  still required.

- **D4 metering follow-up (2026-09-23):** durable operation reserve/finish/cancel is wired to the
  metering service; settlement facts and outbox intent share a tenant transaction. Operation-scoped
  Redis Lua transitions, a dedicated worker queue, and periodic intent recovery are implemented.
  `yarn tsc --noEmit`, scoped ESLint/Prettier, and `git diff --check` pass. Targeted metering, Redis,
  and operation-repository integration suites cannot prepare PostgreSQL (`AggregateError`); database/
  Redis runtime behavior and cache rebuild after data loss remain unverified/open.

- **F3 initial acceptance slice (2026-09-23):** the real-database tenant-boundary suite proves
  that an authenticated local credential cannot retarget a request to a second organization, an
  unauthenticated organization route returns 401, and an authenticated malformed organization route
  returns `400 INVALID_ORGANIZATION`. The tenant guard unit suite and HTTP suite pass (2 suites,
  24 tests).
  The expanded suite now also covers a deterministic concurrent owner-mutation race. The restricted-
  runtime-role, repository access-class, broader concurrency, worker/outbox, replay, and encryption-
  substitution requirements remain open.

## Next barrier

Add the authenticated F4 operator entry point and coordinate E6 API/SDK updates. Then complete clean-
cluster B/C1 and Wave D acceptance, expand F3, and coordinate F1/F2/G1 with the frontend, CLI and release
owners. No release-ready claim is supported until cross-repository acceptance and cutover authority exist.

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

L07 reference-gap baseline (2026-10-05): real template repository acceptance passed 1 suite / 7 tests
on the owned disposable port-55436 database. Those fixtures reference unpersisted groups; current
prepared writes do not check JSON group existence/tenant ownership. Action variants contain no entity
IDs. This baseline establishes the missing validation and does not close L07; implementation follows
inside the deferred mutation transaction with a distinct propagated reference error.

L07 implementation update (2026-10-05): deferred template creation now counts distinct approval-group
IDs through the tenant-scoped database view inside the mutation transaction. This includes replacement
creation, so invalid new references roll back the preceding deprecation. Missing and foreign groups
return the service-owned `workflow_template_approval_group_not_found`; create/update HTTP mapping
preserves that code as a bad request. Deprecation alone does not revalidate existing references.
Repository acceptance passed **1 suite / 9 tests**, including group deletion after preparation and
nested cross-tenant replacement rollback, on the owned port-55436 database. Full TypeScript and scoped
ESLint passed. API fixture/regression acceptance is still in progress; this does not close L07.

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

Current F3 adversarial slice passed 6 suites / 55 tests on 2026-10-05: persisted session authority,
receipt/outbox replay, append-only platform events, encryption binding and dispatch ownership.
[Coverage and explicit gaps](F3-current-coverage.md) record the requirement attribution. L09 remains open;
these results do not establish every endpoint/access class or actual crash/redelivery/resume.

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

E4 live-role gap is now reproduced against real adapters: a JWT principal resolved before committed
role revocation still persists one vote. The new regression intentionally fails (expected zero votes,
observed one); the current gate is red, and the prior 640-test green run predates it. No mocks were
introduced for the reproduction. [Boundary inventory and correction plan](E4-vote-authorization-plan.md)
record the affected ports and required deterministic acceptance. L07/L09 remain open.

User scope correction (2026-10-05): retain optimistic voting without production changes. The rejected
stricter-authority regression was removed. Earlier mandatory-fix claims are superseded. Organization
resume/reconciliation is deferred for later; the operator entry point remains deferred. Current-state
consistency verification follows this correction, rather than requiring those deferred features.

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
