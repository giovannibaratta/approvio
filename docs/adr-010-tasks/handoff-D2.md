# D2 handoff — in progress

Converted group, group-membership, space and workflow-template repository paths to explicit tenant contexts and organization-qualified selectors. Workflow-template actions now use tenant-bound C2 encryption and the `enc_actions` schema field. Group membership handles both local users and agents through tenant composite foreign keys.

Verified on 2026-09-12:

- Scoped ESLint and filtered TypeScript checks pass for all four D2 adapters.
- `yarn test:jest app/external/test/database/group.repository.integration.test.ts`: passed; verifies tenant-qualified group lookup, same-name coexistence and same-organization duplicate rejection.
- `yarn jest --runInBand app/external/test/database/space.repository.integration.test.ts`: passed; proves same-name coexistence and tenant-qualified space lookup.
- `yarn test:jest app/external/test/database`: passed on 2026-09-23 (24 suites, 56 tests), including same-name space isolation and concurrent membership version fencing.
- `app/main/test/integration/workflows/workflow-templates.integration.test.ts`: 1 suite, 62 tests passed on a fresh-cluster clone. A deterministic barrier makes two updates read the same ETag; exactly one succeeds, the other returns conflict, and only versions 1 and 2 exist with one active version.
- `yarn test:jest app/external/test/database/workflow-template.repository.integration.test.ts`: passed after migrating it to direct tenant-aware setup. It verifies encrypted template actions, same-organization revision counting, and foreign-organization read denial.
- `git diff --check` passes.

Current follow-up: the workflow-template integration test also checks that two organizations can
store the same template name/version and that name/version and active-name selectors resolve each
organization's own row. It passes (1 suite, 1 test) against the disposable PostgreSQL test database;
ESLint, `yarn tsc --noEmit`, Prettier, and `git diff --check` pass. The test closes both fixture and
repository database clients and exits without an open-handle warning. An initial sandboxed run could
not reach the host-mapped database; rerunning the focused test with database access succeeded.

The same test now verifies tenant-qualified workflow-template parent lookup and exact-name/space
filtered listing when both organizations use the same template name/version. The focused repository
suite passed again (1 suite, 1 test) on 2026-09-23.

It also exercises the atomic version-copy path and confirms the new revision's actions decrypt under
its destination revision ID, proving the copy is re-encrypted with target binding. The focused test
passed on 2026-09-23.

The group repository suite was rerun after adding assertions that a same-name group lookup resolves
to the requesting organization's row and that a bulk ID lookup in organization A omits organization
B's group. It passed (1 suite, 3 tests).

On 2026-09-23, the group repository suite also verified that a foreign user's group lookup returns no
rows, local member lookup and search listing return only the local group, and listing totals remain
tenant-scoped. The focused suite passed (1 suite, 4 tests).

The group repository integration suite added a focused group-membership case: tenant A cannot add or
remove tenant B's user reference, the tenant-scoped user-membership selector omits it, the group count
remains local, and the existing membership remains unchanged. It also rejects adding a foreign-
organization agent membership and creates, lists, and removes a local agent membership. The suite
passed (1 suite, 4 tests). The tenant-isolation SQL acceptance rejects cross-organization
`group_memberships` and `agent_group_memberships` inserts through their composite foreign keys; all SQL
fixtures rolled back. These close the user/agent group-link checks, not the full D2 selector matrix.

The space repository test now also verifies cross-organization bulk-ID filtering, search listing,
counts, and foreign-ID deletion rejection in addition to ID/name reads. `yarn test:jest
app/external/test/database/space.repository.integration.test.ts` passed (1 suite, 1 test) on
2026-09-23. This closes those space selector cases only; the broader D2 selector matrix remains open.

The workflow-template repository test also confirms a foreign template read and update are rejected,
while a tenant's parent lookup and filtered listing resolve only its own same-name revision. The full
external database folder passed after these D2 changes (24 suites, 56 tests).

The shared `app/test/mock-data.ts` fixture has since been migrated to the current platform-account,
organization and local-membership schema; it no longer imports removed `OrganizationAdmin` or
legacy identity Prisma models. Remaining D2 acceptance requires broader same-org/cross-org/version-
race coverage across all selectors and adapters, followed by the Wave D coordinator gate and
clean-cluster C1 verification.

## L02 continuation — 2026-09-28

Added two focused space mutation tests in `app/external/test/database/space.repository.integration.test.ts`. They verify foreign-user payload rejection, a forged local organization with a foreign user ID, rollback of the first space insert when its scoped user update fails, successful local user update/OCC increment, stale-version rollback, and same-organization duplicate-name rejection without changing the user. The actual `PrismaTransactionManager` is used so a business Left rolls back database writes. The suite passes: 1 suite, 3 tests.

Added a template replacement rollback test in `app/external/test/database/workflow-template.repository.integration.test.ts`. A local duplicate revision causes the second write to fail; the existing revision, encrypted actions and OCC remain unchanged, and no replacement row persists. The suite passes: 1 suite, 2 tests.

Commands: `yarn test:jest app/external/test/database/space.repository.integration.test.ts` and `yarn test:jest app/external/test/database/workflow-template.repository.integration.test.ts`, on the prepared disposable PostgreSQL profile. Fixture setup uses the privileged connection; repository execution uses `DatabaseClient` transactions that set `approvio_tenant_runtime`. These results extend the adapter matrix; they do not close L02 or the Wave D coordinator gate.

Additional implementation gap found by source trace: template repository create/update/copy encrypt and get methods decrypt inside the caller's active database transaction. `TenantEncryptionService` invokes the configured AWS encryption client, so the frozen D2 rule that KMS stays outside DB retry closures is not yet satisfied. Separate encrypted preparation/persistence/read materialization must preserve target binding and current permission/transaction boundaries. Do not mark the slice complete based only on successful encryption tests.

The complete `yarn test:jest app/external/test/database` run passes on this continuation: **26 suites, 66 tests**. Scoped ESLint for both changed test files, `yarn tsc --noEmit --pretty false`, `node docs/adr-010-tasks/verify-contracts.mjs`, and `git diff --check` pass. No clean-cluster Wave D completion claim is made.

## L02 write preparation — 2026-09-28

Replaced the template repository write methods with `prepareCreateWorkflowTemplate`, `prepareUpdateWorkflowTemplate` and `prepareAtomicUpdateAndCreate`. Preparation encrypts before entering the database transaction and returns a database-only write closure. No ciphertext or Prisma rows cross into the service layer. The database operation retains the scoped selectors, OCC checks and atomic existing/new revision writes. Write results validate the stored metadata with the already verified action data, so they do not decrypt inside the transaction.

`WorkflowTemplateService` prepares writes before its final transaction. Creation still checks quota inside that transaction. Revision replacement preloads the template and prepares both revisions, then checks the original OCC during the atomic final write. Deprecation similarly fences its preloaded snapshot. Workflow cancellation and final deprecation still execute together in one transaction; the template is prepared beforehand. Logs remain after successful transaction completion.

Changed files: `app/services/src/workflow-template/interfaces.ts`, `app/services/src/workflow-template/workflow-template.service.ts`, `app/external/src/database/workflow-template.repository.ts`, `app/external/test/database/workflow-template.repository.integration.test.ts`, and `contracts.md`. The frozen write contract now explicitly documents preparation and execution.

The repository suite adds a test that records transaction context at encryption, executes prepared replacement, then re-executes it to exercise its OCC fence. All encryption preparation happens with no active transaction; database execution invokes neither encryption nor decryption. The focused repository suite passes (3 tests). The preceding repository/HTTP suites pass (2 suites, 64 tests), including the existing deterministic revision race.

The read side remains open: selectors still decrypt within their caller transaction. Next work is to separate scoped record loading from action materialization and update the workflow-instantiation caller, preserving permission checks, lifecycle admission, quota and OCC in their proper transaction boundaries. L02 remains open.

After the prepared-write changes, `yarn test:jest` passes **119 suites, 1,120 tests**. `yarn build` passes for backend and worker. Scoped ESLint on all four changed TypeScript files, `yarn tsc --noEmit --pretty false`, contract verification and `git diff --check` pass. These commands validate the write-phase integration; they do not close the read-side or Wave D acceptance gaps.

## L02 read materialization — 2026-09-28

Template reads now expose explicit `loadWorkflowTemplateById`, `loadWorkflowTemplateByNameAndVersion`, `loadActiveWorkflowTemplateByName`, and `loadMostRecentNonActiveWorkflowTemplateByName` operations. They perform only scoped database queries and return a deferred `WorkflowTemplateMaterialization<Result>`. The captured persistence snapshot stays in the adapter; no Prisma record or ciphertext is exposed to services. Callers finish the record-loading transaction before running action decoding and domain validation. Template creation/replacement/deprecation continue to prepare ciphertext before the final OCC-fenced write.

Updated `WorkflowTemplateService` reads/update/deprecation/cancellation and `WorkflowService.createWorkflow`. Workflow instantiation materializes its immutable revision before the final quota-check/create transaction. Template mutation uses the loaded OCC to reject intervening changes. Name lookup falls back to a non-active revision only on active-not-found; storage or decoding failures fail closed. API routes and response shapes are unchanged.

Changed files: `app/services/src/workflow-template/interfaces.ts`, `app/services/src/workflow-template/workflow-template.service.ts`, `app/services/src/workflow/workflow.service.ts`, `app/external/src/database/workflow-template.repository.ts`, `app/external/test/database/workflow-template.repository.integration.test.ts`, `app/main/test/integration/workflows/workflow-templates.integration.test.ts`, and `contracts.md`. HTTP race-test interception targets the renamed loader; its deterministic OCC rejection remains covered.

The repository test records transaction context during all four selector materializations and confirms decryption occurs without an active transaction. Another test injects privileged fixture corruption separately from restricted runtime queries: invalid action JSON in correctly bound ciphertext and ciphertext substituted from another revision are rejected; the intact source remains readable.

Verification: focused repository plus workflow/template HTTP suites pass (3 suites, 119 tests before the added corruption case); final repository suite passes (4 tests). Final `yarn test:jest` passes **119 suites, 1,121 tests**. Backend/worker `yarn build`, scoped ESLint for the six changed TypeScript files, `yarn tsc --noEmit --pretty false`, contract verification and diff checks pass. The read/write KMS placement gap is closed. L02 still requires its complete selector/link matrix and the coordinated clean-database Wave D gate.

Coordinator finding from the LLD/E3 review: JSON approval/action reference existence/ownership checks belong in the service mutation transaction. The current template service validates JSON shape with the domain factory but does not resolve approval-rule group references before persistence. This E3 integration gap must be closed under L07/L09; successful ciphertext/domain-shape tests do not prove foreign-reference rejection.

## L02 selector and rollback matrix — 2026-09-28

Expanded the group tests with scoped name-to-ID/count/direct-member filters, mixed bulk reads, foreign includes/counts, populated foreign agent joins/counts, mixed add/remove rollback and initial group/membership rollback on stale user OCC. Space tests additionally verify successful local deletion leaves the other organization's row intact. Template tests add foreign-only name/version rejection, mixed parent-name failure, scoped parent lookup, foreign-space count, optional non-active None, same-space-name nested filtering and FK rejection of a foreign-space creation link.

Changed tests: `app/external/test/database/group.repository.integration.test.ts`, `space.repository.integration.test.ts`, and `workflow-template.repository.integration.test.ts`. The first run exposed a test fixture name containing a forbidden space; it was corrected before the final passing run. `yarn test:jest app/external/test/database` passes **26 suites, 69 tests**. `yarn test:tenant-isolation:prepared` passes the SQL isolation/composite-FK checks and real tenant/worker capability login assertions on the prepared test profile. Scoped lint and TypeScript pass.

[D2-acceptance.md](D2-acceptance.md) maps repository methods to current evidence and distinguishes absent raw/connect APIs from implemented selectors. The same-wave D3/D4 acceptance and fresh changelog coordinator gate are still required, so L02 stays open while work progresses to those dependencies.


## Fresh-database coordinator acceptance — 2026-09-28

The shared fresh-database blocker is resolved: all 41 Liquibase changesets replayed on a separate
empty PostgreSQL 17.4 cluster; tenant-isolation SQL and real tenant/worker capability logins passed.
The combined adapter/recovery/worker acceptance passed 30 suites and 103 tests; the full suite
passed 119 suites and 1,132 tests. Backend/worker build, TypeScript, scoped lint, contract and diff
checks passed. The commands and scope are recorded in [D4's handoff](handoff-D4.md).

L02 is complete and removed from `LEFT.md`. Broader service/worker and release gates remain open.
