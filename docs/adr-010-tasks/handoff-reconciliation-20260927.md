# ADR-010 reconciliation, 2026-09-27

Status: partial. The current backend Jest gate passes. ADR implementation and cross-repository acceptance remain open in [LEFT.md](LEFT.md).

## Changes

- Made `LEFT.md` the active completion ledger and linked it from the README and current status. Kept older pickup notes for provenance and corrected their stale API-source instructions: member/invitation, ETag, entitlement, and usage declarations already exist in the linked API source.
- Restored the planned `AuthorityResolver` declaration. Source inspection confirms it has no implementation/provider/consumer; operation-aware admission and sensitive-write rechecks remain L01.
- Fixed JWT principal resolution accepting a removed membership. A current session no longer admits a tombstoned local member. Added a focused regression test.
- Fixed worker email/webhook integration tests racing their direct processor invocation against automatic Bull consumption. These direct-invocation tests now isolate publication; dedicated queue integration tests retain real queue coverage.
- Fixed recalculation and status-change queue tests to enqueue explicitly after the outbox transaction commits, matching service-owned publication.
- Fixed agent-member and AuditorViewer fixtures to explicitly share the target organization; random default fixture IDs had created mismatched tenant contexts.
- Fixed the webhook task-repository fixture to use a deterministic task UUID, matching the encryption binding contract.

## Verification

- `yarn tsc --noEmit --pretty false`: passed after the changes.
- `yarn build`: backend and worker passed before the admission fix; final TypeScript and Jest checks passed afterward.
- Scoped ESLint on every changed application/test file: passed.
- `node docs/adr-010-tasks/verify-contracts.mjs`: passed; 63 API operation path mappings and local Markdown links checked.
- `git diff --check`: passed.
- Focused JWT principal suite: 4 tests passed.
- Existing auth integration suite: 24 tests passed. Tenant-boundary HTTP suite: 17 tests passed.
- Quota target-filter regression: 1 test passed, 11 skipped.
- Seven corrected integration suites: 37 tests passed in focused runs.
- Final `yarn test:jest`: **119 suites, 1,110 tests passed** against the prepared local test profile. The first run had 7 failing suites/8 failing tests; all were reproduced or traced and corrected before rerunning.

The repository setup provisioned local test services and applied migrations. Its Jest command could not accept `--runInBand` because `test:jest` already sets `--maxWorkers`; subsequent runs used the supported script without that option. No shared or production environment was reset, deployed, or published.

## Still required

L01–L12 are open. A green existing suite does not satisfy missing authority/lifecycle, Redis rebuild, operator command, adversarial isolation, client, or cutover acceptance. Linked API inspection was read-only; its source/generated artifact/tests were not refreshed or pinned during this pass. Existing dirty worktree edits were preserved.
