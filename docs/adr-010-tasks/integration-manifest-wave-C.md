# Wave C integration manifest

Status: integration state recorded; the Wave C completion gate is not claimed. This manifest is a
working-tree snapshot, not an immutable release artifact. No repository state was committed, stashed,
or published while recording it.

## Repository checkpoints

| Repository                   | Branch and HEAD                                                      | Working-tree state                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace/approvio`        | `multi-org-support` at `3c3bf1fd575b46fc73c0c17a1d12245f0d8c94ab`    | Dirty (266 status entries); ADR-010 implementation and local configuration changes remain uncommitted.                                          |
| `/workspace/approvio-api`    | `adr-010-api-contract` at `6a7b8c2f2a33a10c7c4e1563183b7bf4d57b1e1d` | Clean at manifest capture.                                                                                                                      |
| `/workspace/approvio-ts-sdk` | `main` at `1da5e79a627c1f489d3c03fc4700aeed8b2f57b4`                 | Dirty (12 status entries), including organization/platform client additions and edits; preserve and review before producing a release artifact. |

SHAs identify committed bases only. They do not identify the backend or SDK source contents in the dirty
working trees. The API package remains version `1.0.0`; the SDK manifest resolves
`@approvio/api` through `portal:../approvio-api`. Neither registry publication nor immutable package
artifacts were produced for this snapshot. Existing `dist` and generated OpenAPI directories are
build outputs and are not treated as verified artifacts here.

## Verification evidence

- C1 fresh PostgreSQL 17 validation: all 39 Liquibase changesets applied; tenant-isolation SQL passed;
  transaction-manager tests passed (11 tests); external database tests passed (24 suites, 55 tests).
- C3's recorded handoff reports SDK build and test success (4 suites, 41 tests) against the then-current
  API handoff. The SDK worktree is now dirty, so that result does not verify its present contents.
- Current backend verification recorded in `CURRENT-STATUS.md`: TypeScript, build, scoped lint,
  contract verification, diff check, and 109 suites / 1,062 tests passed against disposable clones of
  the fresh PostgreSQL schema.
- No clean integrated Wave C run against the exact three working-tree contents above has been recorded.
- Since this snapshot was first written, D2 selector isolation, D3 vote/outbox rollback, and bounded
  expiration-batch acceptance were added and verified. The latest full backend/worker run includes all.

## Known deviations and next steps

- The immutable API artifact/checksum required by the original C3 barrier is absent. The local portal
  link is a development handoff only.
- E6's `/o/{organizationId}/entitlements` and `/o/{organizationId}/usage` API contract update and SDK
  regeneration remain pending in the sibling repositories. Their current working trees must be
  inspected before coordinating that work; this manifest does not imply those routes are integrated.
- The backend and SDK trees are dirty. Their current source SHAs cannot be represented by the HEAD
  values above; do not use this manifest as a release pin or as evidence of a complete Wave C barrier.
- Recreate or regenerate immutable artifacts from reviewed source, record content checksums, then run
  the Wave C integration gate before marking the wave complete.
