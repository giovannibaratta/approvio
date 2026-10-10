# L01 — current request authority

> Superseded by the authorization-freshness policy in the main ADR and the updated low-level design: requestor identity is loaded during JWT authentication; the tenant guard checks route and organization lifecycle only. Sensitive operations validate the authenticated requestor against operation data inside their tenant transaction. They do not reload requestor identity or take an organization lock just to serialize revocation.

Date: 2026-09-27. Checkout: `multi-org-support`, HEAD `0a9791f`, with the existing uncommitted ADR-010 work preserved.

## Implemented boundary

`TenantAuthorityService` implements the resolver and recheck port and is provided by `ServiceModule`. It loads the current organization, active account/session/membership or active agent. Browser credentials must match the selected organization and current session context version. Session versions remain `bigint` internally. Agent credentials reference the agent row that owns the key and revocation state; there is no separate credential-ID alias.

`TenantAuthorityGuard` runs after authentication and route tenant matching. Ordinary tenant routes require an active organization. Suspended organizations allow owner/admin organization summaries and owner resume/delete operations; agents and ordinary resource operations remain denied. Platform routes retain their existing explicit allowlist. Deleting/deleted organizations expose no tenant resource access. The guard replaces the requestor with live membership/agent authority. JWT admission rejects removed memberships and stale contexts, and `JwtAuthGuard` preserves expected HTTP exceptions instead of wrapping them as 500 responses.

Sensitive services use `runAuthorized`: lock the organization, reload current authority, then run their existing permission checks and mutation in the same transaction. Voting, role assignment/removal, group membership changes and group creation's manager-role grant, agent registration, member/invitation administration, lifecycle mutations and step-up issuance use this boundary. Mutation-specific business permission checks remain in their services. Existing nested transactions reuse the caller transaction. Standalone `recheck` retains its lock only when called within an enclosing transaction; `runAuthorized` keeps the lock through the complete computation.

This implements the LLD's conservative organization serialization. Authority/lifecycle mutations and sensitive writes in one organization contend on that row. Ordinary reads release their admission transaction before reading resources. Session changes or account disablement observed after admission affect subsequent requests; there is no claim of recalling an already admitted operation. Worker dispatch acceptance and throughput/fairness measurement remain L06/L12 work.

## Contract correction

`contracts.md` now explicitly parameterizes dependency errors instead of treating every failure as an authorization error. The concrete service port unions `AuthorityError`, `MutationError`, `RepositoryDependencyError`, `TransactionError`, `AgentGetError` and `account_not_found`. These remain precise literals. HTTP mapping belongs to guards/controller mappers; storage failures fail closed without being relabeled permission denial. The credential scalar correction matches the existing rule that versions are `bigint` internally and decimal strings on the wire.

## Verification

- `yarn test:jest`: **119 suites, 1,117 tests passed**, using the already prepared disposable PostgreSQL/Redis test profile.
- New real-adapter tenant-boundary tests cover committed membership removal, committed agent/session revocation, suspension versus owner summary, stale browser context (409), storage failure injection (503), and a deterministic organization-lock barrier proving a concurrent role demotion is reloaded before sensitive execution.
- The concurrent duplicate group addition test issues two real HTTP mutations: one succeeds (200), one conflicts (409), and exactly one membership persists. Its old independent fixture insertion inside a locked request would block on the organization foreign key.
- `yarn build`: backend and worker compiled successfully.
- `yarn tsc --noEmit --pretty false`, scoped ESLint, `node docs/adr-010-tasks/verify-contracts.mjs`, and `git diff --check`: passed. The final group-removal lookup adjustment was additionally checked with the group integration suites; agent membership: 28 tests; group/user membership: 64 tests (92 total).

L01 completion does not close the remaining Wave D/E, operator, worker, client, or release acceptance items.

## Changed implementation and test files

- `app/domain/src/authenticated-entity.ts`
- `app/domain/test/tenant-principal.test.ts`
- `app/services/src/tenancy/tenant-authority.service.ts`
- `app/services/src/tenancy/interfaces.ts`
- `app/services/src/service.module.ts`
- `app/main/src/auth/tenant-authority.guard.ts`
- `app/main/src/app.module.ts`
- `app/controllers/src/organizations/organization.controller.ts`
- `app/services/src/auth/jwt-principal.service.ts`
- `app/main/src/auth/jwt.strategy.ts`
- `app/main/src/auth/jwt.authguard.ts`
- `app/controllers/src/error.ts`
- `app/controllers/src/agents/agents.mappers.ts`
- `app/controllers/src/users/users.mappers.ts`
- `app/controllers/src/groups/groups.mappers.ts`
- `app/controllers/src/workflows/workflows.mappers.ts`
- `app/services/src/vote/vote.service.ts`
- `app/services/src/role/role.service.ts`
- `app/services/src/role/interfaces.ts`
- `app/services/src/group-membership/group-membership.service.ts`
- `app/services/src/agent/agent.service.ts`
- `app/services/src/agent/interfaces.ts`
- `app/services/src/tenancy/membership-management.service.ts`
- `app/services/src/tenancy/organization-lifecycle.service.ts`
- `app/services/src/tenancy/invitation-management.service.ts`
- `app/services/src/auth/auth.service.ts`
- `app/services/src/auth/interfaces.ts`
- `app/services/src/group/group.service.ts`
- `app/services/test/auth/jwt-principal.service.test.ts`
- `app/main/test/integration/tenancy/tenant-boundary.integration.test.ts`
- `app/main/test/integration/groups/groups-membership-agents.integration.test.ts`

Documentation: `contracts.md`, this handoff, `LEFT.md`, and `CURRENT-STATUS.md`.
