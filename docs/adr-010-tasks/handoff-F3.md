# F3 handoff: initial tenant-boundary acceptance slice

Status: partial. This handoff records the first executable F3 coverage only; it does not satisfy the
full [F3 acceptance matrix](task-F3.md).

## Changed scope

- Added `app/main/test/integration/tenancy/tenant-boundary.integration.test.ts` against a cloned,
  real PostgreSQL database.
- Made malformed `/o/:organizationId` requests return `400 INVALID_ORGANIZATION` from `TenantGuard`
  instead of a server error, with corresponding unit coverage.

## Proven behavior

- A local credential for organization A cannot read a route scoped to organization B
  (`403 ORGANIZATION_MISMATCH`).
- An organization-scoped route without a credential returns `401`.
- An authenticated request with a malformed organization route parameter returns
  `400 INVALID_ORGANIZATION`.

## Evidence

`yarn jest --runInBand --runTestsByPath app/main/test/unit/tenant.guard.test.ts app/main/test/integration/tenancy/tenant-boundary.integration.test.ts`
passed on 2026-09-23: 2 suites, 24 tests.

The command requires access to the local PostgreSQL integration service. Sandboxed execution cannot
open that connection; the command passed with local-service access.

## Remaining F3 work

The expanded tenant-boundary suite now covers the deterministic owner demotion/removal race. Remaining
F3 work includes restricted runtime-role and RLS assertions; repository lookup/list/count/include/bulk/
raw/JSON coverage; broader concurrency cases; worker/outbox/replay/forged-job coverage; encryption
substitution; and platform metadata boundary checks. No F3 wave-completion claim is made.
