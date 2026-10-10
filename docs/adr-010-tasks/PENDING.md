# ADR-010 earlier pickup notes

These notes predate the [active completion ledger](LEFT.md). Use that ledger for current state and
closure evidence; retain this file as detail for unresolved implementation, acceptance, and
cross-repository work. No checked item here is a wave-completion claim.

## E2 and API contract

- [ ] Verify the existing `/members` and `/invitations` OpenAPI operations and member `ETag`/`If-Match`
      contract against backend routes; regenerate and test validators and SDK artifacts, then pin the
      reviewed API source SHA and artifact. The source declarations already exist as of 2026-09-27.
- [ ] Verify the existing `/o/{organizationId}/entitlements` and `/o/{organizationId}/usage` OpenAPI
      paths against the backend and generated SDK. The source paths already exist as of 2026-09-27.
- [x] Add E2 integration coverage for membership/invitation transaction behavior.
      `tenant-boundary.integration.test.ts` verifies a deterministic concurrent owner demotion/removal
      race, group-link cleanup, audit-failure rollback, inviter demotion, last-owner self-removal, stale
      membership ETags, platform-session-only acceptance, wrong-account rejection, invitation expiry,
      and one-time acceptance.
- [x] Add E2 HTTP/database integration coverage for account-scoped organization discovery, atomic
      organization-plus-owner creation, and owner lifecycle/display-name operations. Evidence is in
      `app/main/test/integration/tenancy/tenant-boundary.integration.test.ts`.
- [ ] Restore and verify authenticated operator command/recovery integration coverage. The historical L05 completion report is unsupported by the current source; the authentication/command adapter and acceptance suite are absent.

## Operator boundary and F4

- [ ] Implement authenticated operator identity and command orchestration, separate from customer login and caller-supplied Actor values.
- [ ] Add explicit bootstrap, owner-restoration, reasoned suspend/resume and grace CLI commands with environment/organization flags and protected individual credentials.
- [x] Define safe repeated bootstrap: verify existing matching setup; preserve ownership and the original committed audit; reject mismatched state.
- [ ] Verify inactive-account rejection, zero-owner concurrency, immutable operator audit facts, atomic setup/audit rollback and insert-only/RLS grants. The historical 43-changeset / 125-suite / 1,170-test claim has no surviving linked acceptance handoff; revalidate against the current tree before marking L05 complete. See [the active ledger](LEFT.md).
- [ ] Complete deployment artifact packaging, fresh-install, cutover and rollback guidance/rehearsals under L11/L12. The previously linked operator guide is absent; document actual setup and invocation after the command adapter is implemented.

## Remaining ADR-010 barriers

- [x] Run B1's tenant-isolation SQL acceptance on the fresh PostgreSQL 17 cluster after all 39
      changesets applied. The script verified RLS isolation, capability-role attributes, organization
      security policies, tenant-qualified writes, and historical attribution, then rolled back fixtures.
- [x] Run C1's transaction-manager, capability-role, type-check, and lint gates from a fresh cluster;
      see [handoff-C1.md](handoff-C1.md). The broader Wave D coordinator gate remains open.
- [x] Record the current Wave C integration snapshot, verification results, and dirty-worktree state
      in [the manifest](integration-manifest-wave-C.md). Immutable API/SDK artifact pinning and the clean
      integrated Wave C barrier remain open; do not treat the snapshot as a completion claim.
- [x] Validate the complete Liquibase changelog from an empty PostgreSQL 17 cluster after adding
      `organizations.plan_tier` to the original schema definition. All 39 changesets applied; the new
      column is `text NOT NULL` and the organization security registration/policies are active.
- [x] Cover D1 repository acceptance scenarios for account-scoped discovery, invitation acceptance,
      last-owner protection, refresh-family reuse, historical voter retention, and concurrent organization
      creation/invitation acceptance/session switching; see [handoff-D1.md](handoff-D1.md). The Wave D
      coordinator acceptance has since passed with L02–L04; broader wave/release barriers remain open.
- [x] Complete D2 adapter selector/link/rollback and crypto-boundary acceptance, then replay the
      fresh-database coordinator checks. See [handoff-D2.md](handoff-D2.md) and the current L02 closure
      in [LEFT.md](LEFT.md); broader service JSON-reference validation remains under L07.
- [x] Prove vote/outbox transaction rollback at the HTTP boundary. A workflow integration test forces
      `workflow.recalculate` outbox insertion to fail and verifies no vote, recalculation marker, or
      outbox row persists; the workflow integration suite passed (1 suite, 54 tests).
- [x] Verify bounded expired-workflow batches advance without skipping or duplicating work. The
      worker expiration integration suite passed (1 suite, 5 tests), and the processor now depends on the
      `WorkflowRecalculation` port with an explicit cutoff and batch size.
- [x] Complete D3 integrated expired/reclaimed-lease fencing and receipt/task/outbox replay/rollback
      acceptance, followed by fresh-database coordinator checks. [D3 evidence](handoff-D3.md).
- [x] Complete D4/E6 durable cache rebuild, admission gating, conservative outstanding holds and
      safe terminal-marker retention. PostgreSQL/Redis same-/cross-tenant replay and injected failures
      pass; the separate fresh-cluster acceptance passes 30 suites / 103 tests, and the full suite passes
      119 suites / 1,132 tests. [D4 evidence and limits](handoff-D4.md). L07 and release gates stay open.
- [x] Implement backend E6 organization-scoped plan resolution for provisioning, features, quota, and
      usage. The selected storage shape is `organizations.plan_tier`, added to the original organization
      schema so no backfill is needed. `DEPLOYMENT_EDITION` is separate from the
      fixed provisioning policy (`FREE` for SaaS, `SELF_HOSTED_UNLIMITED` for self-hosted). See
      [the implementation decision](E6-plan-review.md).
- [ ] Validate and pin the generated API/SDK artifact for the existing
      `/o/{organizationId}/entitlements` and `/o/{organizationId}/usage` source paths.
- [ ] Decide whether to squash the pre-release ADR-010 changelog. Fresh-cluster validation has passed,
      but first confirm that no deployed or shared database has applied changesets that would be
      rewritten; keep applied Liquibase changesets immutable.
- [ ] Complete the deferred F3 restricted-role, repository-boundary, broader race, worker/outbox,
      replay, forged-job, and encryption-substitution acceptance matrix. The owner-mutation race is
      covered by E2, but does not replace the remaining F3 concurrency checks.
- [ ] Coordinate F1/F2 client onboarding and organization switching, then complete G1 artifact pinning,
      cutover rehearsal, and cross-repository release evidence.

## Scope notes

The API/SDK items require changes in the linked `approvio-api` checkout. The operator command and its
authority boundary belong to F4; do not add a public backend route until that boundary exists. The
current backend E2 state and static-check evidence are recorded in [CURRENT-STATUS.md](CURRENT-STATUS.md)
and [handoff-E2.md](handoff-E2.md).
