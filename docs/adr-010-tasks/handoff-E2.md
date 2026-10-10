# E2 handoff: partial backend wiring

Status: in progress. Backend flows and focused E2 boundary tests are wired; linked API contract
updates and broader tenancy acceptance remain open.

## Implemented in this checkpoint

- Added `OrganizationService` over the existing account-discovery, organization-directory, and atomic
  provisioning ports.
- Added platform-session-only `GET /organizations` and `POST /organizations` endpoints. Discovery is
  account-scoped; creation inserts the organization and initial owner through the provisioning adapter.
- Tenant organization summary reads run through the transaction manager before using the restricted
  organization directory client.
- Added tenant-scoped `GET /o/:organizationId` using the existing organization-directory adapter.
- Added owner-only organization display-name updates, owner-requested suspension/resumption, and
  step-up-bound asynchronous deletion under `/o/:organizationId`. These use opaque organization ETags,
  compare-and-swap lifecycle writes, transactionally persisted audit records, and a durable resume event.
- Added `/o/:organizationId/members` listing, role-change and removal operations. Member snapshots carry
  opaque resource ETags for `If-Match`; role-change/removal use compare-and-swap persistence. Each role change/removal
  checks the active-owner count and persists the mutation in a Serializable transaction; serialization
  failures retry the whole computation. Removal clears group links and local roles in the same transaction.
- Added invitation create/revoke/account-bound acceptance under `/o/:organizationId/invitations`.
  Tokens are random one-time secrets; only SHA-256 hashes are persisted, invitations expire after seven
  days, and acceptance requires an authenticated platform session matching the target account.
- Implemented the internal `OperatorRecoveryService` for explicit bootstrap, owner restoration, and
  reasoned lifecycle/grace operations. It requires an active target account, appends platform-security
  intent records, and persists tenant audit records with owner/lifecycle recovery mutations. Bootstrap
  uses the separate provisioning transaction and currently has only its platform-security intent
  record. The service is deliberately not exposed over HTTP: no authenticated operator principal or
  command adapter exists in this backend; F4 must supply that boundary before invocation.
- Moved organization entitlements and usage controller routes from `/organizations/:orgId/...` to
  `/o/:organizationId/...`, taking route context from `TenantContext`.
- Made effective-quota reads run in a tenant transaction and reject a requestor whose membership belongs
  to a different organization. Feature-gate resolution now requires and validates tenant context.
- Usage inspection now rejects a requestor whose membership organization differs from the requested
  organization.

## Static verification

- `yarn tsc --noEmit`: passed.
- Scoped ESLint for the changed controller, service, module, persistence registration, quota, feature-gate,
  and metering files: passed.
- `git diff --check`: passed.
- The full Jest suite passes (109 suites, 1,062 tests; 2026-09-23), including tenant-boundary checks for last-owner
  demotion/removal, a deterministic concurrent owner race, stale membership ETags, removal cleanup and
  audit-failure rollback, and invitation acceptance with platform-session, exact-account,
  inviter-authority, expiry, and one-time-token enforcement. Jest
  reports an open-handle notice after the tests pass.

## Remaining E2 work

The [pickup queue](PENDING.md) tracks the authenticated F4 operator entry point and linked API schema/SDK
generation. Broader tenancy acceptance remains in the F3 matrix. The backend has no authority source
for operators, so do not add a
public route that accepts an `Actor` value as proof of operator identity. Continue using the frozen
transaction, membership, invitation, lifecycle, audit, and outbox boundaries; do not treat provisioning
alone as organization administration.

## Contract coordination

The linked `approvio-api` source still declares entitlements and usage under
`/organizations/{orgId}/...`; it must be changed to `/o/{organizationId}/...` in that repository and its
generated SDK refreshed. The backend controller now follows the ADR-010 route contract.


## Historical operator boundary completion report — 2026-09-28

Reconciled 2026-10-04: the following report is not supported by the current source. The named operator
module, command entry point, authentication adapter, acceptance suite, and completion handoff are absent.
L05 is reopened in the active ledger. Retain this paragraph as history, not current acceptance evidence.

L05 supersedes the earlier missing-operator-boundary statements above. OperatorModule now owns
individual deployment authentication, environment/command grants and explicit operational CLI
commands, using a database-only composition independent of customer OIDC/Redis. Bootstrap writes
organization, initial owner and committed tenant audit atomically; repeat setup verifies matching
state without replacing its audit or owner. Recovery/lifecycle actions retain actual operator
attribution and reason, and audit failure rolls mutations back. Fresh restricted-role/CLI acceptance
and the full 125-suite / 1,170-test regression pass. The claimed L05 acceptance handoff is absent.
The remaining API/SDK artifact work is L08; deployment packaging/rehearsals remain L11/L12.
