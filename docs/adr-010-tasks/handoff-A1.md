# A1 handoff

Result: A1 planning gate complete. Wave B can consume [contracts.md](contracts.md) and the exact source declarations and baseline in [inventory.md](inventory.md). No backend/API implementation has started.

## Selected decisions and changes from LLD

- All nine product-default rows are selected, with invitation grants narrowed to orgRole only at acceptance; explicit local roles/groups follow through existing APIs.
- Preserve the three task payload tables; dispatch_attempts has exactly one concrete composite task FK. Durable tenant_event_receipts closes replay after queue deduplication expires.
- Platform PKCE gets a separate authenticated encryption capability. Tenant context is never fabricated for login data.
- Explicit CLI organization token exchange uses an independent CLI session. Invitation acceptance is an account-authenticated exception on a tenant-qualified path, with no pre-existing membership required.
- Account discovery stores account/org membership projection and joins current directory metadata, avoiding replicated display/status drift.
- Keep the current template CRUD shape and use `(organizationId, name, version)` with an immutable revision UUID; no separate template-family entity or endpoints. Internal template cancellation becomes an authenticated tenant-qualified API. Spec-only agent listing and template deletion are explicitly assigned for implementation.
- The B2 context-first repository transformation preserves all exact baseline generic signatures and result/error types in inventory.md except the enumerated identity/task replacements. No generic repository rewrite is required.
- Existing admin_action step-up remains resource-bound; delete_organization is separate. Neither grants permissions independently of live IAM.
- ADR 010 authoritative sessions and transactional quota admission override the contrary ADR 001/009 assumptions. F4 updates those ADRs.

## Baseline preservation

Backend: `8ca9dc7a47aba37ab23aad1e8787338a06b293d3`, no content drift from `37f38f3`.
API: `7502198ec856329cf63c43e18c8316706e84610e`.
SDK: `1da5e79a627c1f489d3c03fc4700aeed8b2f57b4`.
Frontend: `cfb4eea123773d6025dd2d05c8451ff101f345ca`.
CLI: `6be8bb459c89c96d835d2a267864d93d1bd3f966` plus 15 staged files (427 insertions, 94 deletions), listed in inventory.md.

CLI staged binary diff SHA256: `b95ab05e67af77d8c27ed0a86b13876618262c00c910e3b262abbc16870ec7ba` from `git diff --cached --binary | sha256sum`. This fingerprint detects drift; it is not a backup. Preserve the actual existing changes before branching F2. A1 has not altered them. Other backend untracked work is recorded and excluded.

No new API version is invented in A1. B3 produces the actual version/source artifact after its gates. Human publication is optional; recorded local linking/tarballs remain supported. The absence of a B3 artifact does not block A1, but does block its C/E consumers.

## Coverage and review

The [requirement coverage matrix](README.md#requirement-coverage) remains the launch mapping. Contracts specify all existing model dispositions plus session, invitation, task lease/attempt, outbox/consumer receipt, step-up receipt, durable usage operation/settlement and tombstone storage. The route transformation covers all 63 spec operations, with additional controller-only route dispositions. Backend API import declarations, service interfaces, raw-query sites, worker processors, Redis mechanisms and encryption callers are captured in the inventory.

Review applied backend architecture/code-review guidance: domain rules stay pure; service interfaces do not import adapters; transactions exclude replayed external effects; dependency ports precede peer implementations; D and E ownership conflicts are explicitly assigned; no authority bypass through internal routes, platform login, scheduler or reconciliation. Scope changes to proposed defaults are documented above. B/C/D gates remain scoped; the complete application first builds at E as agreed.

## Verification

- `git diff --stat 37f38f3 HEAD`: no backend content drift.
- `node docs/adr-010-tasks/inventory.mjs`: read-only source inventory generated successfully. Initial sandbox run failed with `Error: spawnSync git EPERM`; approved escalated rerun succeeded. Generator output was saved using apply_patch.
- `node docs/adr-010-tasks/verify-contracts.mjs`: strict TypeScript checking of all contract code blocks passed; all 63 API operations have path mappings; local Markdown links resolve. The check establishes path coverage, not semantic API correctness.
- `git diff --no-index --check /dev/null <new-file>`: no whitespace errors for the new contract. Planning files are untracked, so ordinary git diff cannot show them.
- No application build, database migration, integration suite, package publication or reset ran; A1's wave gate requires planning review, not runtime evidence. B1/C1/D/F3 must supply restricted-role and race-test evidence.

Files added: contracts.md, inventory.md, inventory.mjs, verify-contracts.mjs, handoff-A1.md. A1 task, wave A and README link the completed handoff. Scripts only read source and emit/check planning data; no application runtime files changed.

## Next handoff

Start B3 against the frozen route/model contract if an early API PR/publication is desired. B1 and B2 may proceed independently from the same baseline. Review changes to a frozen interface at the B barrier before SDK/transaction/crypto work starts. Later code may reveal a contract defect; correct it explicitly and rerun affected gates rather than silently diverging.
