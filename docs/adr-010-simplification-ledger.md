# ADR-010 simplification review ledger

Review baseline: last commit `16ee930f5c12a336b63b114e475ed253e29b1155` and unstaged working-tree changes, inspected on 2026-09-25. Untracked implementation files are inspected where they explain those changes. Staged-only changes are context, not a separately completed review.

This began as a static review for smaller, clearer changes. Only this ledger was changed during the review; suggested validation had not been run at that point. Security boundaries, tenant scoping, OCC, encryption binding and durable retry semantics must survive any cleanup.

## Earlier implementation follow-up — 2026-09-25

All ten findings (S02–S06 and S08–S12) have been addressed. Focused validation passed:

- `yarn tsc --noEmit`
- `yarn build`
- 2 focused unit suites: 27 tests passed
- 4 related integration suites: 93 tests passed
- Targeted ESLint and valid/invalid tenant-route rule examples

`app/domain/src/organization.ts` still reports pre-existing lint violations; the validation-branch merge reduced its complexity score from 29 to 25. No database schema or tenant-security behavior was changed by this simplification work.

## Findings

### S02 — Remove an unused compatibility alias introduced by a type rename

- **Source:** unstaged `app/external/src/database/group.repository.ts:23–26`.
- **Evidence:** the rewritten repository uses `GroupRecord`, then exports `PrismaGroupWithCount = GroupRecord`. A search under `app` finds no consumers of `PrismaGroupWithCount` outside this declaration.
- **Recommendation:** retain the original type name for the updated shape, or remove the unused exported alias. Prefer retaining the name if minimizing rename churn is the aim.
- **Benefit:** avoids maintaining two names for one record shape; small, low-risk reduction.
- **Validation:** type-check and the group repository integration tests.

### S03 — Remove the identity error transformation around group mapping

- **Source:** unstaged `app/external/src/database/group.repository.ts:79`, mapper signature at line 220.
- **Evidence:** `mapGroup` already returns `Either<"unknown_error", Versioned<GroupWithEntitiesCount>>`; the create path wraps it in `E.mapLeft(() => "unknown_error" as const)` before `TE.chainEitherKW`.
- **Recommendation:** pass `mapGroup` directly to `TE.chainEitherKW`. The error and success values are unchanged.
- **Benefit:** removes a callback and a redundant error conversion without changing the persistence boundary.
- **Validation:** type-check the create method and run its existing integration test.

### S04 — Consolidate identical group-list mapping loops

- **Source:** unstaged `app/external/src/database/group.repository.ts:247–265`.
- **Evidence:** `mapGroups` and `mapGroupList` have identical bodies: map each record with `mapUnversionedGroup`, return the first error, otherwise collect results. Only the declared array element type differs (`Group` versus `GroupWithEntitiesCount`). Both actually return objects containing counts.
- **Recommendation:** use the count-preserving mapper at both call sites; its results are structurally compatible with `Group[]`. Keep the separate versioned mapper where OCC is needed.
- **Benefit:** removes one complete duplicate loop, approximately nine lines, without changing returned data or validation order.
- **Validation:** type-check and exercise both bulk lookup and paginated list integration tests.

### S05 — Remove redundant nested transaction wrappers in role mutations

- **Source:** unstaged `app/services/src/role/role.service.ts`: outer calls at 203, 282, 360, 437; inner calls at 235, 313, 390, 467. Supporting implementation: `app/external/src/database/database-client.ts:124–143` and `transaction-manager.ts:46–71`.
- **Evidence:** all four role mutations now wrap the full operation in `txManager.execute(request.context, ...)` but retain the old inner wrapper around update plus audit. Inner calls use the same context and no stronger isolation. The database client reuses the active transaction; these are not savepoints.
- **Recommendation:** retain each outer transaction and compose update plus audit directly inside it. Keep propagation of either failure to the outer transaction so rollback stays atomic.
- **Benefit:** removes four redundant transaction/error-adaptation layers and associated indentation.
- **Validation:** role integration tests, especially rollback when audit persistence fails and OCC conflicts.

### S06 — Filter bound roles directly instead of translating through request roles twice

- **Source:** unstaged `app/services/src/role/role.service.ts:220–227,299–306,377–383,454–460`.
- **Evidence:** each audit-delta calculation first filters `request.roles` by name AND scope, then filters the validated bound roles by name alone. Example: an existing role in space A and newly added same-named role in space B causes both bound roles to appear in the assignment delta.
- **Recommendation:** filter `boundRolesToAssign`/`boundRolesToRemove` directly against existing roles using both `name` and `RoleFactory.isSameScope`; invert the predicate for assignment versus removal.
- **Benefit:** removes four temporary request-role lists and their second matching pass; also fixes loss of scope information in audit selection. This is a behavior correction, not just cosmetic cleanup.
- **Validation:** add focused coverage for the same role name in two scopes, with only one assignment/removal actually changing state.

### S08 — Merge three identical non-suspended organization validation branches

- **Source:** last commit, `app/domain/src/organization.ts:108–153`.
- **Evidence:** the `active`, `deleting`, and `deleted` branches each reject a non-null suspension reason, create `{...baseData, status}`, and brand it. Only the status literal and intermediate variable name differ.
- **Recommendation:** handle these three recognized statuses together using the narrowed `data.status`. Keep the suspended branch separate and preserve rejection of unknown status values and invalid suspension metadata. Preserve the discriminated public types.
- **Benefit:** eliminates two repeated validation/return blocks, roughly ten lines, without broadening the accepted input.
- **Validation:** domain organization tests for all statuses, non-null suspension reasons, and unknown status values.

### S09 — Collapse the identical active/deleting persistence payload branches

- **Source:** untracked dependency of the lifecycle changes, `app/external/src/database/lifecycle.repository.ts:67–72`.
- **Evidence:** the `data` ternary tests `input.status === "active"`, but both branches return exactly `{status: input.status, suspensionReason: null, graceUntil: null, updatedAt: new Date()}`.
- **Recommendation:** retain the suspended case and one fallback payload for the other two variants. Keep the preceding transition-condition logic intact: active and deleting have different permitted source states.
- **Benefit:** removes a provably redundant conditional with no policy change.
- **Validation:** existing lifecycle transition integration coverage.

### S10 — Share the two identical pagination parsers — already consolidated

- **Source:** untracked controllers used by the organization changes, `app/controllers/src/organizations/account-organizations.controller.ts:114–119` and `memberships.controller.ts:114–119`.
- **Evidence:** both `parsePositiveInteger` functions have identical checks and behavior; only parameter/local names differ. Both callers use page default 1, limit default 20, and maximum limit 100.
- **Review result:** `account-organizations.controller.ts` and `memberships.controller.ts` now both use `parsePositiveInteger` from `organization.mappers.ts`; the recommendation is already implemented.
- **Benefit:** removes duplicated parsing policy and prevents pagination validation drifting across the new routes. Small benefit; lower priority than S05/S06.
- **Validation:** pagination tests for absent, zero, negative, nonnumeric, fractional and unsafe-integer values.

### S11 — Delete the legacy user-update helper after removing its callers

- **Source:** unstaged group/space repository rewrites remove imports of `persistExistingUserRaceConditionFree`; retained file `app/external/src/database/shared/user-operations.ts:1–50`.
- **Evidence:** searches for the helper, its input type and module path under `app` find only the helper file itself. It still writes the removed tenant-user `email` field and serializes role scopes without `organizationId`.
- **Recommendation:** delete the unused helper and its private mapper/input type rather than adapting this obsolete parallel implementation to the new schema.
- **Benefit:** removes 50 lines of dead legacy persistence code and avoids a misleading alternative to the tenant-aware updates. This adds a deletion to the diff but reduces code that reviewers must reconcile.
- **Validation:** confirm no remaining module imports, then type-check. No new helper-specific tests are needed after deletion.

### S12 — Share the duplicated tenant-route lint-rule check

- **Source:** last commit, `eslint.config.mjs:22–45`.
- **Evidence:** `Literal` and `TemplateElement` visitors repeat the same regex, parameter comparison and error message. Only the source string accessor differs (`node.value` versus `node.value.raw`).
- **Recommendation:** use one local check function accepting the node and candidate string, called by both visitors. Preserve both visitors and the rule; it enforces a real route convention.
- **Benefit:** reduces the new custom rule and leaves one copy of its matching/reporting policy.
- **Validation:** lint-rule examples with valid/invalid string literals and template literals, plus non-string literals.

## Current unstaged and untracked review — 2026-09-26

### S13 — Compose group-membership simulation through `Either`

- **Source:** unstaged `app/services/src/group-membership/group-membership.service.ts`, `simulateAddMemberships` and `simulateRemoveMemberships`.
- **Evidence:** both functions manually inspect `isLeft` inside loops and convert each branch back to `TaskEither`; `GroupManager.addMemberships` already composes the add sequence as an `Either`.
- **Recommendation:** keep the simulation synchronous as `Either`, compose the manager creation and membership operations with `pipe`/`E.chain`, and lift the result once with `TE.fromEither`. Keep removal sequential because last-administrator checks depend on the evolving manager state.
- **Benefit:** preserves authorization, validation order, and simulation behavior while removing nested hand-written left propagation.
- **Status:** implemented; `yarn tsc --noEmit --pretty false` passes. Service-level tests are absent; the relevant integration suites require the database setup.

### S14 — Fold vote eligibility instead of branching on `isRight`

- **Source:** unstaged `app/services/src/vote/vote.service.ts`, `canVote` result conversion.
- **Evidence:** an `Either` result is inspected with `isRight`, then separately branches on its left value to either propagate `inconsistent_memberships` or return a normal denied-vote response.
- **Recommendation:** use `E.fold` to map allowed votes, expected denials, and inconsistent-membership failure into `TaskEither` values in one composition.
- **Benefit:** makes the three outcomes explicit and keeps error and denial semantics unchanged.
- **Status:** implemented; `yarn tsc --noEmit --pretty false` passes. Vote eligibility behavior remains covered at the domain layer; no dedicated service unit test exists.

### S15 — Use named parallel results and remove impossible resource-list guards

- **Source:** unstaged `app/services/src/resources/resources.service.ts`, `resolveResources`.
- **Evidence:** the service sequenced exactly two repository calls into an array, then guarded its fixed length and elements before destructuring. These states cannot occur when the typed sequence succeeds.
- **Recommendation:** retain parallel fetching with `sequenceS(TE.ApplicativePar)`, name the `spaces` and `groups` results, and map the pure categorization directly in the `TaskEither` pipeline.
- **Benefit:** removes impossible `unknown_error` branches and makes the values and parallel operations explicit without changing authorization or response ordering.
- **Status:** implemented; TypeScript passes.

### S16 — Preserve explicit tenant overrides in the domain user mock

- **Source:** unstaged `app/test/mock-data.ts`, `createMockUserDomain`.
- **Evidence:** after switching the helper to tenant-aware `createTestUser`, it generated a random organization ID but exposed no override parameter, unlike the stated fixture convention that a caller may pass a known ID when a test needs one.
- **Recommendation:** accept narrow optional overrides for organization/account IDs, display name, and organization role, while generating random IDs by default.
- **Benefit:** removes magic shared tenant identity from fixtures and permits deliberate cross-fixture relationships.
- **Status:** implemented; the full TypeScript build and changed-file ESLint pass.

### S17 — Continue the outbox relay scan beyond its first organization page

- **Source:** new `app/worker/src/processor/tenant-outbox-relay.processor.ts`.
- **Evidence:** `OrganizationDirectoryRepository.listForScheduler` is a keyset-paginated query, but the relay always called it with a null cursor and processed only the first 50 organizations. Every later organization would therefore be starved on every scheduled run.
- **Recommendation:** continue from the last organization ID until the final short page, matching the existing usage-settlement and expiration-sweep scans.
- **Benefit:** preserves bounded queries and per-organization event batches while ensuring all organizations are visited.
- **Status:** implemented with a regression test covering 51 organizations; the focused worker suite passes.

### S18 — Preserve task-generation coverage while adapting fixtures to the durable event contract

- **Source:** unstaged `app/worker/test/integration/workflow-task-generation.integration.test.ts`.
- **Evidence:** the rewrite retained receipt/rollback/replay cases but removed existing coverage for multiple actions and event-snapshot precedence. Those behaviors remain in the processor and are independent of the new persistence contract.
- **Recommendation:** keep those assertions in the migrated integration test rather than dropping behavior coverage as collateral to fixture adaptation.
- **Benefit:** verifies multiple tasks retain action indexes and that a queued event uses its immutable action snapshot even if the template changes later.
- **Status:** adapted the retained test to create multiple email/webhook actions, change the persisted template after event creation, and assert event-snapshot task payloads; TypeScript/build pass, database verification is pending because the disposable test database cannot be created.

### S19 — Align dispatch recovery with the durable task state machine

- **Source:** new email, Slack, and webhook processors; `app/external/src/database/dispatch-admission.repository.ts`; `app/domain/src/durable-task.ts`.
- **Evidence:** each processor calls `complete(..., state: "failed")` when loading the task fails, before `markSending`; the adapter accepts completion only from `sending`, so this returns `lease_lost` and the processor ignores that result. The durable item remains `claimed`, and `isClaimable` accepts only `ready`/`retry_due`, leaving it unreclaimable after lease expiry. Separately, the domain documents `unknown -> claimed` retry, but the adapter excludes `unknown`; only webhooks pass a stable downstream idempotency key, while email and Slack do not.
- **Recommendation:** record pre-send failures as safe retries, and permit unknown-outcome retries only when the destination honors the stable idempotency key. Preserve unknown outcomes for operator resolution on destinations without safe deduplication.
- **Benefit:** prevents permanently stranded claimed work and avoids unsafe blind retries after ambiguous email/Slack delivery outcomes.
- **Status:** implemented: pre-send failures now release the durable item to `retry_due`, the processor checks that this result was persisted, and only webhook work can be reclaimed from `unknown` because it uses the task ID as an idempotency key. The durable-task comment now records that constraint. Integration tests cover both transitions; database execution remains pending because the disposable test database cannot be created.

### S20 — Use the persisted platform-account FK in the invitation isolation assertion

- **Source:** new `app/main/test/integration/tenancy/tenant-boundary.integration.test.ts`.
- **Evidence:** the invitation assertion queried the local `User` table with the removed `accountId` field. The schema stores that relation as `platformAccountId`; `yarn build` caught the stale field.
- **Recommendation:** keep the isolation assertion and query the current FK.
- **Benefit:** preserves the intended test while matching the tenant-membership schema.
- **Status:** corrected; `yarn build` passes.

### S21 — Keep the new planning scripts within repository JavaScript style

- **Source:** new ADR-010 `inventory.mjs` and `verify-contracts.mjs` scripts.
- **Evidence:** changed-file ESLint reported CommonJS `require` imports, single quotes, semicolons, and formatting violations across the scripts.
- **Recommendation:** use native `.mjs` imports and Prettier formatting, retaining the scripts' read-only inventory and contract-check behavior.
- **Benefit:** the planning utilities now pass the same style checks as application code without adding lint exceptions.
- **Status:** renamed to `.mjs`, formatted, syntax-checked, and linted; `verify-contracts.mjs` passes.

## Cross-cutting review notes — 2026-09-26

- Rechecked S02–S12 against the current tree: the unused group alias and legacy user-update helper are absent; group creation passes `mapGroup` directly and bulk paths share `mapGroups`; role mutations have one transaction boundary and scope-aware audit matching; the organization branches, lifecycle payload, pagination parser, and ESLint route check match their recommendations. The lifecycle's remaining status conditional distinguishes the suspended payload from the shared active/deleting payload and is required.
- `package.json` adds `@approvio/api: portal:/workspace/approvio-api`. This points at a sibling checkout by absolute path, so it is machine-specific and should not be treated as a portable dependency declaration. The current local build uses it to type-check against the sibling API contract; replacing it safely requires publishing/versioning that contract or using a repository-supported workspace mechanism. Keep this as an integration/setup concern and do not silently broaden this review into dependency redesign.
- The untracked `docs/adr-009-tasks/` and `native-evaluators-requirements.md` artifacts are outside ADR-010. They were preserved because they pre-existed this review and may be user work; they should be excluded from an ADR-010 change unless intentionally included. The ADR-010 handoff/planning files and `docs/internal/tenant-security-automation.md` are relevant project artifacts, not application runtime changes.
- Validation in this review is recorded per finding above. Current database-backed integration verification is blocked at disposable test database creation (`CREATE DATABASE`); build, focused unit tests, lint, contract checks, and whitespace checks passed. This does not establish full ADR-010 runtime readiness; see `docs/adr-010-tasks/CURRENT-STATUS.md` for the wave gates.
