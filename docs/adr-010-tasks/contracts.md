# ADR 010 A1 contracts

Status: A1 contract baseline. This document selects the LLD defaults and defines their implementation shapes. The A1 handoff records verification; any later correction must update this baseline and rerun the affected wave gates before its consumers proceed.

## Baseline and precedence

Use the exact repository HEADs in [inventory.md](inventory.md). Backend HEAD has no file-content changes from `37f38f3`. API, SDK and frontend are now on clean main checkouts; the earlier feature-branch observations are superseded. CLI retains the explicitly listed staged user changes: its baseline is HEAD plus that existing diff, not HEAD alone. Before F2, preserve that diff in an isolated feature checkout or an authorized baseline commit; never discard it. No branches, commits, pushes, publication or environment resets were performed by A1.

All nine LLD product-default rows are selected: explicit onboarding, UUID paths and immutable slug, organization-scoped workflow-template names and immutable revision UUIDs, multiple owners, account-bound invitations with seven-day expiry, reasoned suspension, deletion tombstones, and operator-configured grace without payment automation. ADR 010 overrides ADR 001 stateless-session lookup and ADR 009 tolerated count/create races. Keep the existing FP-TS layers and resource-specific repositories; no generic CRUD abstraction is introduced.

## Shared scalar and error rules

UUIDs remain strings validated by domain factories; dates are `Date` internally and RFC3339 strings on the wire. OCC stays `bigint` internally. Context/lifecycle/resource versions are decimal strings on the wire and `bigint` in persistence, avoiding JSON precision loss. Organization slug matches `^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$`; UUID and slug are permanently reserved. Existing resource name validation is retained.

```typescript
import {TaskEither} from "fp-ts/TaskEither"
export interface TenantContext {
  readonly organizationId: string
}
export type OrgRole = "owner" | "admin" | "member"
export type OrgStatus = "active" | "suspended" | "deleting" | "deleted"
export type SuspensionReason = "owner_requested" | "security" | "abuse" | "payment" | "operator"
export type BoundaryError =
  | "invalid_organization_id"
  | "tenant_context_required"
  | "organization_mismatch"
  | "conflicting_isolation_level"
  | "retry_exhausted"
  | "commit_outcome_unknown"
  | "storage_unavailable"
  | "concurrency_error"
export type AuthorityError =
  | BoundaryError
  | "invalid_credential"
  | "organization_not_found"
  | "organization_context_changed"
  | "organization_suspended"
  | "organization_deleting"
  | "permission_denied"
  | "step_up_required"
  | "step_up_invalid"
  | "step_up_consumed"
export type MutationError =
  | AuthorityError
  | "invalid_reference"
  | "resource_not_found"
  | "resource_already_exists"
  | "resource_in_use"
  | "last_owner"
  | "invalid_transition"
  | "quota_exceeded"
  | "invitation_invalid"
export type IsolationLevel = "ReadCommitted" | "RepeatableRead" | "Serializable"
export interface TenantTransactionManager {
  execute<E extends string, T>(
    context: TenantContext,
    computation: () => TaskEither<E, T>,
    options?: {readonly isolationLevel?: IsolationLevel}
  ): TaskEither<E | BoundaryError, T>
}
```

Existing domain validation/business errors remain, unioned with BoundaryError. Do not replace precise errors with an arbitrary string. Retry only the outer DB-only closure: three total attempts, base 25 ms, cap 250 ms with jitter. Preserve business Left rollback. Parameterize transaction-local context on every attempt. Cross-org nesting fails; stronger nested isolation fails. Serialization/deadlock/OCC are retryable, ambiguous commit and arbitrary P2028 are not. Encryption, Redis and external calls stay outside the closure.

Authority resolution preserves dependency failures separately from authorization decisions. The implementation specializes the resolver error parameter with `MutationError | RepositoryDependencyError | TransactionError | AgentGetError | "account_not_found"`; `AuthorityResolutionError` in `app/services/src/tenancy/interfaces.ts` is the concrete union. Repository failures are never converted to permission denial. Tenant-user credentials retain `sessionContextVersion` as `bigint` internally; agent credentials refer to the agent row, which owns their key and revocation state.

## Existing repository conversion

[inventory.md](inventory.md) preserves exact existing interface declarations, including generic return types and optional arguments. The frozen transformation for every tenant repository method is to prepend `context: TenantContext` to its argument list and union BoundaryError into its TaskEither error. Retain other arguments, generic parameters and return shape. Every persisted tenant entity and create record gains required `organizationId`; writes reject a payload/context mismatch. Reads, lists, counts, include trees, bulk operations and raw queries all apply this same rule. Repository methods require an already-open matching transaction; they cannot establish authority from an arbitrary ID or fall back to root Prisma.

Applies to GroupRepository, GroupMembershipRepository, SpaceRepository, WorkflowTemplateRepository, WorkflowRepository, VoteRepository, AgentRepository, AgentChallengeRepository, TaskRepository, QuotaRepository, AuditLogRepository and UsageEventRepository. UserRepository is tenant-local with the exceptions below. Tenant service request types extend trusted tenant-principal context; controllers obtain it from authority resolution, never spread it from request JSON.

Explicit replacements:

- Remove UserRepository.createUserWithOrgAdmin, createUserWithIdentity, createUserWithOrgAdminAndIdentity, getUserByEmail and hasAnyOrganizationAdmins. Login uses PlatformIdentityRepository; owner creation uses provisioning. `createUser` becomes an internal membership write, not public arbitrary user creation.
- Replace OrganizationAdminRepository with MembershipRepository. Owner/admin is a local membership role, not an email relationship.
- UserIdentityRepository becomes PlatformIdentityRepository keyed by configured provider, validated issuer and subject. No email lookup or linking.
- RefreshTokenRepository splits into account/session and tenant-agent repositories. PKCE stays platform-scoped with immutable optional step-up target, never a tenant-data bypass.
- WorkflowTemplateRepository writes use `prepareCreateWorkflowTemplate`, `prepareUpdateWorkflowTemplate` and `prepareAtomicUpdateAndCreate`: each performs external preparation before the transaction and returns a database-only `() => TaskEither<Error, Versioned<WorkflowTemplate>>`. Execute that operation in the caller tenant transaction; OCC checks and revision replacement remain atomic there. Prepared closures capture ciphertext without exposing encryption or Prisma records to services.
- WorkflowTemplateRepository reads use `loadWorkflowTemplateById`, `loadWorkflowTemplateByNameAndVersion`, `loadActiveWorkflowTemplateByName` and `loadMostRecentNonActiveWorkflowTemplateByName`. Each performs its scoped query in the caller transaction and returns `WorkflowTemplateMaterialization<Result>`, an external decoding task executed after that transaction. The captured snapshot stays inside the adapter; services receive a validated domain entity only after action decryption succeeds. Updates fence the snapshot with OCC in the final write.
- WorkflowTemplateRepository name/version lookup becomes `(context, templateName, version)`. Names and role scopes resolve only inside the trusted organization context; existing template UUID remains the immutable revision ID. There is no separate template-family entity.
- TaskRepository retains per-type payload operations. Its lock methods are replaced by durable claim/fence methods below; a process-local lock owner or OCC alone cannot authorize completion.
- HealthRepository remains platform operational `SELECT 1` and migration version checks; never expose its client to tenant repositories.
- Bulk mutation accepts only same-org IDs and fails the entire transaction if any ID is absent/foreign. No partial success for mixed-org batches.

## Identity, session and membership ports

```typescript
export interface Account {
  readonly id: string
  readonly displayName: string
  readonly status: "active" | "disabled"
}
export interface OrganizationSummary {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly status: OrgStatus
  readonly occ: string
}
export interface Membership {
  readonly id: string
  readonly organizationId: string
  readonly accountId: string
  readonly displayName: string
  readonly status: "active" | "removed"
  readonly orgRole: OrgRole
}
export interface Session {
  readonly id: string
  readonly accountId: string
  readonly providerId: string
  readonly selectedOrganizationId: string | null
  readonly occ: string
  readonly transport: "browser" | "cli"
  readonly expiresAt: Date
}
export type Actor =
  | {readonly type: "user"; readonly id: string; readonly displayName: string}
  | {readonly type: "agent"; readonly id: string; readonly displayName: string}
  | {readonly type: "operator"; readonly id: string; readonly displayName: string}
  | {readonly type: "system"; readonly id: string; readonly displayName: string}
export type AdmissionOperation =
  "resource" | "management_summary" | "membership_recovery" | "resume" | "delete" | "vote" | "authority_change"
export interface PlatformIdentityRepository {
  resolveIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
  }): TaskEither<BoundaryError | "account_not_found", Account>
  createIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
    readonly displayName: string
  }): TaskEither<BoundaryError | "identity_exists", Account>
  getOwnAccount(accountId: string): TaskEither<BoundaryError | "account_not_found", Account>
}
export interface AccountDiscoveryRepository {
  listOwn(
    accountId: string,
    page: number,
    limit: number
  ): TaskEither<BoundaryError, {readonly items: readonly OrganizationSummary[]; readonly total: number}>
  setMembershipProjection(context: TenantContext, accountId: string, present: boolean): TaskEither<BoundaryError, void>
}
export interface SessionRepository {
  getOwn(accountId: string, sessionId: string): TaskEither<AuthorityError, Session>
  switchContext(
    accountId: string,
    sessionId: string,
    organizationId: string,
    expectedOcc: string
  ): TaskEither<AuthorityError, Session>
  revokeOwn(accountId: string, sessionId: string): TaskEither<AuthorityError, void>
}
export interface OrganizationDirectoryRepository {
  get(context: TenantContext): TaskEither<BoundaryError | "organization_not_found", OrganizationSummary>
  listForScheduler(afterId: string | null, limit: number): TaskEither<BoundaryError, readonly OrganizationSummary[]>
}
export interface OrganizationProvisioner {
  create(
    accountId: string,
    input: {readonly slug: string; readonly displayName: string}
  ): TaskEither<MutationError, {readonly organization: OrganizationSummary; readonly owner: Membership}>
}
export interface MembershipRepository {
  getByAccount(context: TenantContext, accountId: string): TaskEither<MutationError, Membership>
  getById(context: TenantContext, userId: string): TaskEither<MutationError, Membership>
  list(
    context: TenantContext,
    page: number,
    limit: number
  ): TaskEither<MutationError, {readonly items: readonly Membership[]; readonly total: number}>
  admit(context: TenantContext, accountId: string, orgRole: OrgRole): TaskEither<MutationError, Membership>
  changeRole(context: TenantContext, userId: string, orgRole: OrgRole): TaskEither<MutationError, Membership>
  remove(context: TenantContext, userId: string): TaskEither<MutationError, void>
  countActiveOwners(context: TenantContext): TaskEither<BoundaryError, number>
}
```

JWT authentication loads the current account, browser session, membership, or agent and provides that entity to the request. Tenant admission checks the route and organization lifecycle. A request admitted before a concurrent revocation may complete; subsequent requests observe committed revocation. Mutations validate the requestor against relevant current domain configuration inside the tenant transaction and preserve operation-specific invariants such as the last active owner.

Browser session switch CAS increments on every switch including A→B→A. GET session returns authoritative context. Late cookie responses cannot authorize stale context; a 409 stops mutation and requires session reload without replay. CLI has its own session and obtains an explicitly org-bound token through `POST /auth/cli/select-organization`; switching CLI never updates a browser session. Provider connection belongs to the stored session and survives refresh. Agent subject is UUID, never name.

## Routes and wire shapes

`O` below expands exactly to `/o/{organizationId}`. Every path parameter named organizationId is a required UUID; `orgId` spelling in existing usage/entitlements becomes organizationId. Preserve current HTTP methods, request/response schemas, pagination and operationIds except explicit changes below. These rules cover every operation enumerated in inventory.md, including spec-only operations; B3 and E must reconcile both surfaces.

| Existing path                                                                                                                     | New path / decision                                                                                               | Owner                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| /health                                                                                                                           | /health; alias implementation from internal health, sanitized public readiness only                               | E1                                  |
| /ping                                                                                                                             | /ping, explicitly public liveness and added to spec                                                               | E1                                  |
| /internal/health                                                                                                                  | operational-only health, no tenant data; excluded from public spec                                                | E1                                  |
| /auth/providers, /auth/web/login, /auth/web/callback, /auth/web/refresh, /auth/web/logout                                         | unchanged global authentication                                                                                   | E1                                  |
| /auth/cli/initiate, /auth/cli/token, /auth/cli/refresh                                                                            | unchanged global authentication; explicit org token exchange below                                                | E1                                  |
| /auth/web/initiatePrivilegedTokenExchange, /auth/web/exchangePrivilegedToken                                                      | O + existing path                                                                                                 | E1                                  |
| /auth/cli/initiatePrivilegedTokenExchange, /auth/cli/exchangePrivilegedToken                                                      | O + existing path                                                                                                 | E1                                  |
| /auth/agents/challenge, /auth/agents/token, /auth/agents/refresh                                                                  | O + existing path                                                                                                 | E1                                  |
| /auth/info                                                                                                                        | O/auth/info for local principal information; new /account for platform profile                                    | E1                                  |
| /agents, /agents/register, /agents/{agentIdOrName}, /agents/{agentId}/roles                                                       | O + existing path; listAgents is spec-only today and must be implemented                                          | E2                                  |
| /roles                                                                                                                            | O/roles                                                                                                           | E2                                  |
| /users (GET), /users/{userId}, /users/{userId}/roles                                                                              | O + existing path; local user UUID, no email lookup                                                               | E2                                  |
| /users (POST)                                                                                                                     | removed; account-bound invitation acceptance creates membership                                                   | E2                                  |
| /organization/{organization-name}/admins                                                                                          | removed all methods; explicit member orgRole APIs below                                                           | E2                                  |
| /groups, /groups/{groupIdentifier}, /groups/{groupId}/entities                                                                    | O + existing path                                                                                                 | E3                                  |
| /spaces, /spaces/{spaceId}                                                                                                        | O + existing path                                                                                                 | E3                                  |
| /workflow-templates (GET/POST)                                                                                                    | O/workflow-templates; create includes name + spaceId                                                              | E3                                  |
| /workflow-templates/{templateIdentifier} (GET/PUT/DELETE)                                                                         | O/workflow-templates/{templateId}; UUID identifies immutable version; PUT preserves current permitted edits       | E3                                  |
| /workflow-templates/{templateIdentifier}/deprecate                                                                                | O/workflow-templates/{templateId}/deprecate                                                                       | E3                                  |
| /internal/o/{organizationId}/workflow-template/{templateId}/cancel-workflows                                                     | Remains internal-only; organization-scoped; excluded from the public API contract                                 | E3                                  |
| /workflows, /workflows/{workflowId}, /workflows/{workflowId}/vote, /workflows/{workflowId}/votes, /workflows/{workflowId}/canVote | O + existing path                                                                                                 | E4                                  |
| /quotas, /quotas/{quotaId}, /audit-logs, /audit-logs/me, /resources/resolve                                                       | O + existing path                                                                                                 | E6 for quotas/audit; E3 for resolve |
| /organizations/{orgId}/entitlements, /organizations/{orgId}/usage                                                                 | O/entitlements, O/usage                                                                                           | E6                                  |

New endpoints (all B3 schemas/validators, E implementations):

| Method/path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Request                                                                   | Success                                                               | Owner |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| GET /account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                      | 200 Account + accountId shareable for invitation                      | E1    |
| GET /organizations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | page/limit                                                                | 200 {items: OrganizationSummary[], total, page, limit}, own discovery | E2    |
| POST /organizations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | {slug, displayName}                                                       | 201 {organization, owner}                                             | E2    |
| GET /auth/web/session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                      | 200 {selectedOrganizationId: UUID or null} + ETag                     | E1    |
| POST /auth/web/select-organization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | {organizationId} + If-Match                                               | 200 session context + ETag + HttpOnly replacement cookies             | E1    |
| POST /auth/cli/select-organization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | {organizationId}                                                          | 200 existing TokenResponse, explicitly org-bound                      | E1    |
| GET O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                      | 200 OrganizationSummary                                               | E2    |
| PATCH O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | {displayName}                                                             | 200 OrganizationSummary; owner only                                   | E2    |
| POST O/suspend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | {}                                                                        | 200 OrganizationSummary; owner_requested reason, owner only           | E2    |
| POST O/resume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | {}                                                                        | 200 OrganizationSummary; owner_requested only                         | E2    |
| DELETE O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none; use the organization- and operation-bound step-up bearer credential | 202 OrganizationSummary with deleting status                          | E2    |
| GET O/members                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | page/limit                                                                | 200 {items: Membership[], total, page, limit}                         | E2    |
| PATCH O/members/{membershipId}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | {orgRole} + If-Match                                                      | 200 Membership + ETag                                                 | E2    |
| DELETE O/members/{membershipId}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | If-Match                                                                  | 204, clears local roles/groups                                        | E2    |
| POST O/invitations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | {accountId, orgRole}                                                      | 201 {id, expiresAt, token}; token returned once                       | E2    |
| DELETE O/invitations/{invitationId}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none                                                                      | 204 revoked                                                           | E2    |
| POST O/invitations/{invitationId}/accept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | {token}                                                                   | 200 Membership; platform-authenticated target account                 | E2    |
| DELETE O/agents/{agentId}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | none                                                                      | 204 revoked, history retained                                         | E2    |
| Invitation acceptance is an explicit tenant-path/platform-credential exception: only the exact authenticated invited account may use it, without pre-existing membership, and no tenant reads are granted until acceptance commits. Agent challenge/token are similarly target-qualified credential-establishment routes. New operationIds use camelCase method intent (`getOwnAccount`, `listAccountOrganizations`, `createOrganization`, `getWebSession`, `switchWebOrganization`, `selectCliOrganization`, `getOrganization`, `updateOrganization`, `suspendOrganization`, `resumeOrganization`, `deleteOrganization`, `listMembers`, `changeMemberRole`, `removeMember`, `createInvitation`, `revokeInvitation`, `acceptInvitation`, `revokeAgent`). |

Member display-name search is fuzzy within the selected organization. A complete email address performs only an exact, case-insensitive match among that organization’s memberships; it is never a platform-wide account search or an invitation-target lookup. Conditional HTTP mutations use the opaque `ETag` returned by the resource representation in `If-Match`; internal persistence versions are never exposed on the wire.

Workflow-template payloads gain `organizationId` and retain the existing `name`, `version`, `spaceId`, and immutable revision `id`. New versions increment inside the `(organizationId, name)` transaction. Names may repeat across organizations but never resolve globally. Version UUID never changes. Delete rejects retained references; deprecate where history retains the revision.

Wire errors retain existing `{...}` business payloads where unaffected; new boundary failures use `{code: UPPERCASE_ERROR, message: string}` with no foreign identifiers. 400 invalid org UUID/request; 401 invalid/revoked credential; 404 absent membership, unknown org/resource or path/credential org mismatch; 409 stale browser context, last owner, invalid transition, resource in use; 412 failed `If-Match` precondition; 423 suspension visible only to current authorized members; 403 local permission denial; 503 unavailable authority/storage or retry exhaustion. Deleting tenant access returns non-enumerating 404. Lifecycle responses expose reason only to current owner/admin. Never choose tenant from headers.

API import impact: all declarations in inventory.md are in scope. Preserve sorting, pagination, AuthProvider, approval-rule literals, quota/tier/metric enum values and unaffected validation-error export names. Replace OrganizationAdmin/Create/Remove and their list validators with Membership and invitation/role-operation schemas; remove UserCreate public validator and createUser operation. Change User/UserSummary to local identity (id, organizationId, accountId, displayName, orgRole plus existing local roles); move login profile to Account. Auth info/token/agent schemas gain the discriminated context shapes above. Update all resource responses with required organizationId; tenant create requests take organization only from path. B3 owns source validators, tests, mocks and generated export checks. E tasks own their matching backend import/mapping changes; coordinator owns package pins. No generated file is edited manually.

## Database matrix

Every tenant table below uses policy T: non-null immutable organization_id FK to organizations(id), ENABLE + FORCE RLS USING/WITH CHECK context equality, indexes beginning organization_id, and unique(organization_id,id) when id exists. Parent relationships between tenant rows use (organization_id,parent_id) → (organization_id,id). RESTRICT/NO ACTION deletion is default for all history parents; no physical principal/resource deletion at launch. Runtime is neither owner nor SUPERUSER/BYPASSRLS and cannot assume migration role, run DDL or TRUNCATE. Migration metadata is inaccessible to tenant clients. B1 tests column/trigger immutability with both runtime and maintenance credentials.

| Current/new table                             | Scope / keys and parent rules                                                          | Delete and extra state                                                                                            | Adapter owner |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------- |
| databasechangelog, databasechangeloglock      | migration only, existing keys                                                          | existing Liquibase ownership                                                                                      | B1            |
| organizations (new)                           | directory; id UUID, unique immutable slug                                              | status, suspension_reason, grace_until, occ, timestamps; tombstone forever                                        | D1            |
| platform_accounts (new)                       | platform; UUID id, display_name, status, optional profile email nonunique              | restrictive identity/session parents                                                                              | D1            |
| user_identities → platform_account_identities | platform; account FK, configured provider key; unique(provider,issuer,subject)                     | replaces user FK/email uniqueness, account disabled not deleted                                                   | D1            |
| users                                         | T; unique(org,platform_account_id), account FK                                         | status active/removed, org_role, display snapshot, roles, occ; no global email unique                             | D1            |
| organization_admins                           | removed after empty-data precondition                                                  | authority moves to users.org_role                                                                                 | D1            |
| organization_invitations (new)                | T; target_account FK, inviter local-user composite FK, token_hash unique               | expires_at, revoked_at, accepted_at, requested org_role, occ; retained                                            | D1            |
| users                                         | T; unique(org,platform_account_id), indexed by account/status/org for discovery        | active local memberships are queried by the dedicated discovery capability; no duplicated organization projection | D1            |
| browser_sessions (new)                        | platform session; account FK, configured provider key, nullable selected_org FK                       | transport browser/cli, context_version, expires_at, status, occ                                                   | D1            |
| refresh_tokens                                | platform; account/session FKs, session/provider binding, unique token_hash, family index                | existing rotation status/hash/next-token, no local-user or agent FK                                               | D1            |
| agent_refresh_tokens (new)                    | T; agent composite FK, unique(org,token_hash), org/family index                        | existing rotation and expiry state                                                                                | D1            |
| pkce_sessions                                 | platform prelogin; existing state PK, configured provider key                                      | nullable session/account target; step-up org, operation, resource, context_version; encrypted verifier            | D1            |
| agents                                        | T; unique(org,agent_name)                                                              | active/revoked, public key, roles, occ; no cascade votes                                                          | D1            |
| agent_challenges                              | T; agent composite FK, unique(org,nonce)                                               | expiry/use state                                                                                                  | D1            |
| groups                                        | T; unique(org,name)                                                                    | reject referenced deletion; retired flag preserves JSON/history references                                        | D2            |
| group_memberships                             | T; PK(org,group_id,user_id), composite parents; org/user index                         | explicit delete on removal only                                                                                   | D2            |
| agent_group_memberships                       | T; PK(org,group_id,agent_id), composite parents                                        | explicit delete on revocation only                                                                                | D2            |
| spaces                                        | T; unique(org,name)                                                                    | reject referenced deletion                                                                                        | D2            |
| workflow_templates                            | T; unique(org,name,version), existing UUID, composite space FK                         | immutable revision identity; encrypted actions; no separate family table                                          | D2            |
| workflows                                     | T; unique(org,name), composite template-version FK                                     | retain status, expiry, occ; resource version drives events                                                        | D3            |
| votes                                         | T; composite workflow/user/agent FKs, exactly-one voter CHECK                          | preserve group snapshot; no cascade history; org/workflow/actor/time index                                        | D3            |
| workflow_actions_email_task                   | T; composite workflow FK                                                               | existing payload + durable fields below                                                                           | D3            |
| workflow_actions_webhook_tasks                | T; composite workflow FK                                                               | existing payload + durable fields below                                                                           | D3            |
| workflow_actions_slack_tasks                  | T; composite workflow FK                                                               | existing payload + durable fields below                                                                           | D3            |
| tenant_outbox (new)                           | T; unique(org,event_id); org/available_at/id index                                     | type, schema_version, resource id/version, JSON payload, lease owner/until, published_at, attempts                | D3            |
| dispatch_attempts (new)                       | T; exactly one nullable email_task_id/webhook_task_id/slack_task_id, each composite FK | attempt UUID, fencing, status, occ, timestamps, sanitized outcome; unique task-parent/fence partial indexes       | D3            |
| step_up_receipts (new)                        | T; unique(org,jti), local user FK, session FK retaining provider binding                                | operation/resource UUID, context_version, expires_at, consumed_at; durable single-use                             | D1            |
| quotas                                        | T; unique(org,scope,quota_type,target_id)                                              | org-scope target equals org ID CHECK; polymorphic parent validated under transaction                              | D4            |
| usage_events                                  | T; existing event UUID, unique(org,event_id)                                           | immutable actor/resource snapshots, quantity; org/metric/time index                                               | D4            |
| usage_operations (new)                        | T; unique(org,metric,period,operation_id)                                              | estimate, actual nullable, actor/resource snapshot, status reserved/settled/cancelled, request digest, occ        | D4            |
| usage_settlement_intents (new)                | T; composite usage_operation FK, unique(org,operation_id,revision)                     | desired terminal fact, applied_at nullable, available_at, attempts; org/pending index                             | D4            |
| audit_logs                                    | T; retain UUID, JSON versioned snapshot                                                | no cascading actor/resource FK; tenant-leading actor/entity/time indexes + existing BRIN                          | D4            |
| platform_security_events (new)                | platform append-only; UUID id                                                          | actual account/operator actor, reason, redacted metadata, timestamp                                               | D4            |

Task relational decision: retain the three existing task payload tables to minimize code movement. Add event_id, action_index, initiating_actor snapshot, lease_owner, lease_until, fencing bigint, available_at and state to each; unique(org,event_id,action_index) within each type. Attempts reference exactly one concrete task table, enforced by CHECK and composite FKs, avoiding an unenforced polymorphic taskId. Remove old lockedAt/lockedBy semantics after callers use fenced leases. Store webhook credentials/payload and Slack webhook URL inside encrypted payload envelopes; template actions and task payloads must not leak secrets through diagnostic fields.

Platform policies use separate restricted capabilities: validated identity lookup, own account/session access, own discovery, provisioning, and scheduler directory metadata. No tenant repository receives a platform client. Provisioning atomically inserts directory, establishes generated org context, inserts owner and projection. Membership projection writes share the tenant transaction through a narrowly granted operation constrained to that org/account. Directory status and tenant admission read the same authoritative row. Platform identity prelogin may resolve only the verified (provider,issuer,subject) triple, not arbitrary account queries. Exact SQL grants and functions are B1 implementation details subject to these access sets and restricted-role tests.

Fresh migration applies all new structures then introspects Prisma. Any nonempty application table, including auth/session and task records, fails before destructive alteration; Liquibase metadata is excluded from that check. No inferred default tenant. Runtime startup requires the new migration version. Keep old applied changelogs immutable.

## Lifecycle and invitation contracts

Suspended owners/admins can read only org status, members for recovery, usage/entitlement summaries, and perform permitted membership recovery. Ordinary resource reads, role expansion, invitations, votes and new dispatch are denied. Owner can resume only owner_requested suspension. Operator reasoned recovery may resume other reasons with platform operator authentication and tenant audit; there is no customer operator route. Deleting/deleted deny all customer authority and new dispatch. Existing attempt settlement uses a separate worker reconciliation capability, not an HTTP admission flag.

State transitions: active→suspended(reason), suspended→active(permitted reason), active/suspended→deleting(owner step-up or explicitly audited operator), deleting→deleted reserved for future purge implementation and disabled now. Grace remains active until an idempotent operator-configured due transition; no default duration. Every change is serialized under the org lock. Member active→removed clears groups/roles/projection; removed→active reuses local UUID and requires explicit new grants.

Invitations initially grant only orgRole; fine-grained roles/groups are assigned after acceptance through existing tenant APIs. This narrows the LLD's optional proposed-grants shape and avoids snapshotting arbitrary stale scope grants. Admin cannot invite owner or alter owner. Acceptance locks org/invitation/inviter, verifies target account, unexpired unused hash, current inviter authority and lifecycle, then admits and marks accepted atomically. Reuse/wrong account returns invitation_invalid without disclosing target. Owners may invite owners. Last-owner protection includes leave, remove, demote and account-disable effects; platform account disable invokes audited recovery semantics and never silently selects another owner.

## Durable work, quota, audit and encryption ports

```typescript
export type EventType =
  "workflow.recalculate" | "workflow.status_changed" | "task.ready" | "organization.resumed" | "usage.settlement"
export interface EventBase extends TenantContext {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly resourceId: string
  readonly resourceVersion: string
}
export type TaskKind = "email" | "webhook" | "slack"
export interface TaskEvent extends EventBase {
  readonly type: "task.ready"
  readonly taskId: string
  readonly taskKind: TaskKind
}
export type TenantEvent =
  | TaskEvent
  | (EventBase &
      (
        | {readonly type: "workflow.recalculate"}
        | {
            readonly type: "workflow.status_changed"
            readonly previousStatus: string
            readonly status: string
            readonly actor: Actor
          }
        | {readonly type: "organization.resumed"; readonly occ: string}
        | {readonly type: "usage.settlement"; readonly operationId: string; readonly revision: string}
      ))
export interface Lease {
  readonly owner: string
  readonly fencing: string
  readonly expiresAt: Date
}
export type TaskState = "ready" | "claimed" | "sending" | "succeeded" | "retry_due" | "failed" | "unknown" | "paused"
export type WorkError =
  BoundaryError | "task_not_found" | "lease_lost" | "capacity_exceeded" | "invalid_transition" | "event_mismatch" | "organization_suspended"
export interface OutboxRepository {
  append(context: TenantContext, event: TenantEvent | TaskEvent): TaskEither<BoundaryError | "event_mismatch", void>
  claim(
    context: TenantContext,
    owner: string,
    now: Date,
    limit: number
  ): TaskEither<BoundaryError, readonly {readonly event: TenantEvent | TaskEvent; readonly lease: Lease}[]>
  acknowledge(context: TenantContext, eventId: string, lease: Lease): TaskEither<WorkError, void>
}
```

Dispatch persistence uses the [DispatchRepository contract](../../app/services/src/durable-work/interfaces.ts) and [branded snapshots and transitions](../../app/services/src/durable-work/dispatch.models.ts). Its operations are `getWork`, `getAttempt`, `countActive`, `persistTransition`, and `recordReceipt`. The repository applies tenant/state/version/fence/owner/expiry predicates and maps persisted outcomes; it does not select recovery, retry, capacity, lease-duration, or completion policy.

The concrete [DispatchService](../../app/services/src/durable-work/dispatch.service.ts) owns transactions and coordinates transition factories. Capacity count and claim share one Serializable transaction, including the whole-operation retry boundary. TaskService owns organization lifecycle admission, Redis capacity and heartbeat scheduling. Renewal timing comes from dispatch configuration, rather than the lease client contract. Completion records a consumer receipt in the same transaction when required; old Bull jobs with no remaining outbox FK target retain their existing behavior.

```typescript
// Barrier correction (2026-09-12): the legacy per-type task values do not contain
// the immutable event identity or actor snapshot required by the B1 task tables.
// Every task persistence write therefore carries these facts explicitly. Payload
// fields remain typed at the domain boundary and are encrypted by the D3 adapter.
export interface TaskPersistenceMetadata {
  readonly eventId: string
  readonly actionIndex: number
  readonly initiatingActor: Actor
  readonly availableAt: Date
}
export interface TaskCreateRequest<T> {
  readonly task: T
  readonly metadata: TaskPersistenceMetadata
}
export interface WorkflowRecalculation {
  recalculate(context: TenantContext, workflowId: string, eventId: string): TaskEither<MutationError, void>
  expireDue(context: TenantContext, now: Date, limit: number): TaskEither<MutationError, number>
}
export interface QuotaAdmission {
  checkCreate(
    context: TenantContext,
    input: {
      readonly resourceType: "user" | "agent" | "group" | "space" | "workflow_template" | "workflow"
      readonly parentId: string | null
      readonly quantity: number
    }
  ): TaskEither<MutationError, void>
}
export interface UsageOperation extends TenantContext {
  readonly operationId: string
  readonly metric: "MAX_LLM_TOKENS_PER_MONTH" | "MAX_EVALUATIONS_PER_MONTH" | "MAX_CREDITS_PER_MONTH"
  readonly period: string
  readonly entityType: string
  readonly entityId: string
  readonly actor: Actor
  readonly estimatedUnits: number
  readonly isBillable: boolean
}
export type UsageError =
  BoundaryError | "quota_exceeded" | "operation_mismatch" | "invalid_transition" | "invalid_usage"
export interface AuditRecord extends TenantContext {
  readonly id: string
  readonly actor: Actor
  readonly entityType: string
  readonly entityId: string
  readonly action: string
  readonly occurredAt: Date
  readonly payload: Readonly<Record<string, unknown>>
}
export interface TenantAuditRepository {
  append(context: TenantContext, record: AuditRecord): TaskEither<BoundaryError | "event_mismatch", void>
}
export interface EncryptionContext extends TenantContext {
  readonly resourceType: "workflow_template" | "email_task" | "webhook_task" | "slack_task"
  readonly resourceId: string
  readonly field: "actions" | "payload"
  readonly formatVersion: 1
}
export type CryptoError = "encryption_failed" | "decryption_failed" | "binding_mismatch" | "unsupported_format"
export interface TenantEncryption {
  encrypt(context: EncryptionContext, plaintext: string): TaskEither<CryptoError, string>
  decrypt(context: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
  reencrypt(source: EncryptionContext, target: EncryptionContext, ciphertext: string): TaskEither<CryptoError, string>
}
export interface PlatformEncryption {
  encryptPkce(state: string, providerId: string, plaintext: string): TaskEither<CryptoError, string>
  decryptPkce(state: string, providerId: string, ciphertext: string): TaskEither<CryptoError, string>
}

// Barrier correction (2026-09-12): platform security events are append-only
// operational facts and require a dedicated platform capability rather than a
// tenant audit client.
export interface PlatformSecurityEvent {
  readonly id: string
  readonly actor: Actor
  readonly reason: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly occurredAt: Date
}
export interface PlatformSecurityEventRepository {
  append(event: PlatformSecurityEvent): TaskEither<"unknown_error", void>
}
```

Usage metering is coordinated by the concrete `UsageMeteringService`, without a separate service interface. Organization resume/reconciliation is deferred by the 2026-10-05 scope correction in `LEFT.md`; its eventual service should likewise own orchestration directly. `DispatchRepository` persists fenced dispatch transitions; `DispatchLeaseClient` manages Redis capacity leases. `TenantAuditRepository` describes the planned persistence boundary for tenant audit writes.

Use the existing domain UsageMetric alias for the identical literal union above. Audit action/entity values preserve the existing audit domain validation and add organization/membership/invitation/agent lifecycle actions in B2. QuotaAdmission is a DB-only check called while holding the organization lock and inside the count+create transaction, so it never owns a separate commit. Audit/outbox append in the same commit. Step-up receipt consumption is a conditional unused/unexpired update bound to org/session/provider/occ/operation/resource and committed with the mutation. Vote/recalculation/outbox identities are durable and duplicates compare immutable facts.

Additional ports required by peer tasks (all signatures live in B2, not service implementation files):

```typescript
export interface StepUpReceipt extends TenantContext {
  readonly jti: string
  readonly userId: string
  readonly sessionId: string
  readonly providerId: string
  readonly occ: string
  readonly operation: "vote" | "admin_action" | "delete_organization"
  readonly resourceId: string
  readonly expiresAt: Date
}
export interface StepUpReceiptRepository {
  issue(context: TenantContext, receipt: StepUpReceipt): TaskEither<AuthorityError, void>
  consume(context: TenantContext, receipt: StepUpReceipt, now: Date): TaskEither<AuthorityError, void>
}
// Invitation is the branded domain model, including timestamps for accepted/revoked states.
export interface InvitationRepository {
  create(context: TenantContext, invitation: Invitation): TaskEither<MutationError | RepositoryDependencyError, void>
  getById(context: TenantContext, invitationId: string): TaskEither<MutationError | RepositoryDependencyError, Versioned<Invitation>>
  persist(context: TenantContext, invitation: Invitation, expectedOcc: bigint): TaskEither<MutationError | RepositoryDependencyError, void>
}
export interface LifecycleRepository {
  getSummary(context: TenantContext): TaskEither<MutationError | RepositoryDependencyError, OrganizationSummary>
  get(context: TenantContext): TaskEither<MutationError | RepositoryDependencyError | OrganizationValidationError, Versioned<Organization>>
  persistTransition(context: TenantContext, expectedVersion: bigint, organization: Organization): TaskEither<MutationError | RepositoryDependencyError, OrganizationSummary>
}
export interface OperatorRecovery {
  bootstrap(
    operator: Actor,
    accountId: string,
    organization: {readonly id: string; readonly slug: string; readonly displayName: string}
  ): TaskEither<MutationError, OrganizationSummary>
  restoreOwner(
    operator: Actor,
    context: TenantContext,
    accountId: string,
    reason: string
  ): TaskEither<MutationError, Membership>
  setLifecycle(
    operator: Actor,
    context: TenantContext,
    input:
      | {readonly action: "suspend"; readonly reason: SuspensionReason}
      | {readonly action: "resume"; readonly reason: string}
      | {readonly action: "set_grace"; readonly dueAt?: Date; readonly reason: string}
  ): TaskEither<MutationError, OrganizationSummary>
}
export interface EventReceiptRepository {
  record(
    context: TenantContext,
    consumer: "recalculation" | "task_generation" | "lifecycle" | "usage",
    eventId: string
  ): TaskEither<BoundaryError | "event_mismatch" | "repository_dependency_error", "new" | "duplicate">
}
export interface DispatchLeaseClient {
  acquire(context: TenantContext, taskId: string, owner: string): TaskEither<WorkError | "capacity_exceeded", Lease>
  renew(context: TenantContext, taskId: string, lease: Lease): TaskEither<WorkError, Lease>
  release(context: TenantContext, taskId: string, lease: Lease): TaskEither<WorkError, void>
}
export interface UsageCacheSnapshot {
  readonly consumed: number
  readonly operations: ReadonlyArray<{
    readonly operationId: string
    readonly estimatedUnits: number
    readonly revision: string
    readonly state: "reserved" | "settled" | "cancelled"
    readonly actualUnits: number | null
  }>
}
export interface UsageOperationRepository {
  cacheSnapshot(context: TenantContext, metric: UsageOperation["metric"], period: string): TaskEither<UsageError, UsageCacheSnapshot>
  reserve(input: UsageOperation): TaskEither<UsageError, "new" | "duplicate">
  finish(
    input: UsageOperation,
    result: {readonly state: "settled"; readonly actualUnits: number} | {readonly state: "cancelled"}
  ): TaskEither<UsageError, void>
  pending(context: TenantContext, limit: number): TaskEither<UsageError, readonly UsageOperation[]>
  acknowledge(context: TenantContext, operationId: string, revision: string): TaskEither<UsageError, void>
}
```

OperatorRecovery is injected only into the operator entry point with authenticated operator identity; accepting an Actor value does not grant operator authority. The implemented entry point is a database-only CLI module. Its OperatorAuthenticator verifies individual deployment credentials, exact environment binding and explicit command grants; trusted configuration determines the actor. There is no public recovery route or customer-token operator grant. OrganizationProvisioner.bootstrap(accountId, organization, audit) receives a domain-validated ORGANIZATION_CREATED AuditLog and commits it with the new directory/owner rows. Its provisioning capability has context-bound INSERT-only audit access, declared in the authoritative tenant_audit profile and the existing table policy. Repeat bootstrap verifies an identical existing setup without rewriting ownership or appending another committed creation audit. StepUpReceiptRepository is injected into authorized mutation services and auth issuance, never called directly by HTTP parsing. LifecycleRepository.lock serializes membership role and removal changes to preserve the last active owner, and operator-recovery flows use it when changing owner membership. Ordinary tenant admission reads lifecycle state without locking. Session changes use their session-context CAS; an already admitted request may finish after a concurrent lifecycle or membership change. Worker dispatch also reads status without taking this lock and accepts a race with an uncommitted suspension.

Worker dispatch uses a separate binding of the existing tenant-transaction-manager contract with the
restricted worker capability. `WorkerLifecycleRepository.getStatus` reads only the current
organization's status; the worker has column-limited SELECT access and no organization-table UPDATE
grant. `TaskService` owns active-status decisions for claim and the final sending transition. A worker
that sees a non-active status parks work; a worker that reads the old active status before a concurrent
suspension commits may proceed. An already-sending attempt may still record its outcome after suspension.

Preserve the current `admin_action` step-up literal with explicit resource binding and live permission checks; add `delete_organization` as a separate operation whose resourceId is the org UUID. A receipt proves authentication assurance only, never admin authority. Workflow status strings in stored event snapshots must pass the existing domain status validator before consumption.

Feature gate signatures are frozen as `isFeatureEnabled(context: TenantContext, feature: FeatureKey): TaskEither<FeatureGateError | BoundaryError, boolean>` and `getEffectiveEntitlements(context: TenantContext): TaskEither<FeatureGateError | BoundaryError, EffectiveEntitlements>`, retaining the existing declared result types in inventory.md. Remove the optional org argument. Hierarchy/resource resolution services prepend TenantContext and validate every ancestor in the same org; existing resource resolution request/result fields otherwise remain. These are E6 and E3 responsibilities respectively.

Dispatch service admission returns either an admitted claim or a parked result. Inactive ready/retry
work pauses without an attempt; suspension after claim pauses the fenced work and closes the unsent
attempt with category `organization_paused` in the same worker transaction. Processors acknowledge
parked deliveries without egress. Already-sending attempts remain eligible for outcome reconciliation.
Ready parking never converts unknown external outcomes into resumable paused work.

Task persistence returns committed task-ready events to `TaskService`. The service enqueues each event
best effort after commit, then marks the outbox fact published on queue acceptance. Repository and
database-client code do not publish. Failed delivery leaves durable facts for the recovery relay;
duplicate generation receipts return no newly committed events.

Queue bodies contain only versioned identifiers, not credentials/destinations or decrypted actions. Status-change consumers load stored versioned transition facts: tenant_outbox payload stores previous/new status and initiating actor at emission time. Every event's stored org/resource/version must match; current workflow state alone cannot reconstruct an older transition. Persist a unique processed-event record per consumer in `tenant_event_receipts` (T, unique(org,consumer,event_id), FK to retained outbox event) in the same transaction as task generation/recalculation. B1 owns this additional table; D3 owns its adapter. Outbox records remain retained while receipts/tasks reference them.

Claim leases default to 60 seconds with renewal every 20 seconds; use fencing for every state write. Expired claimed work may return to ready; expired sending becomes unknown, never automatically ready. Redis concurrency lease acquisition happens before DB claim, release after completion or failed claim, with owner-token checked renewal/release; no external call starts without both valid leases. Default 4 sends per org; bounded relay 100 events/org/pass. Lease loss cannot recall an in-flight request. Unknown email/Slack is parked; webhook replay only with supported Idempotency-Key semantics. Never retry logical 4xx except 429 or arbitrary database/network ambiguity.

Usage operation identities are (org,operationId), with metric and billing period included in the immutable request facts. Validate nonnegative safe integers and existing UsageMetric literals. Persist durable reservation before external work; Redis applies idempotent per-operation reserve, and failed admission leaves a reconcilable non-executed operation. No work starts until both durable state and cache reservation confirm. Settling/cancelling records a unique durable intent before Redis updates; duplicate calls with different actor/resource/estimate/actual fail. Cache rebuild includes outstanding reservations plus immutable usage facts and gates new admissions until reconciled. Do not let TTL expiration release an active durable reservation. Recovery claims a 60-second cache-local lease using Redis time, reads operations and their operation-linked immutable events in a RepeatableRead transaction, then installs aggregates and replay markers atomically outside the transaction. Admission and settlement fail closed for missing or rebuilding keys. A reconstructed reservation is conservative: a retry must recheck the effective limit before confirming it; an ambiguous/non-executed durable operation requires explicit cancellation or settlement rather than silently freeing capacity. Consumption belongs to the operation's billing period, even when its event is written in a later month. Event and settlement identities include the organization. Terminal-only keys expire after period end plus 90 days; historical rebuild/replay retains them for at least another 24 hours. Outstanding holds prevent expiry; totals and markers always share the same key lifetime.

Encryption is authenticated context comparison on decrypt, not a plaintext tag beside ciphertext. Reencrypt forbids source/target org mismatch. Template copy and task materialization decrypt outside transaction, encrypt for preallocated destination UUID, then validate source version inside transaction before write; retry only DB operations using the prepared blob. Platform PKCE binding uses platform/state/provider separately, never a fabricated organization. KMS keyring infrastructure is retained.

## Redis and raw-query inventory decisions

The source inventory records the A1 baseline; revalidate source matches at each barrier. Current runtime raw SQL covers health `SELECT 1`, transaction role/context setup in the database clients, and explicit row locks for invitation and lifecycle operations. Tenant row-lock queries bind the organization and resource IDs inside the active tenant transaction. No template-family count query remains because the frozen model has no template-family entity. Test database creation and audit cleanup remain isolated admin-only helpers.

| Existing mechanism                                   | Frozen scope                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| usage prefix + org/metric/period                     | deployment `tenancy-v1` namespace, hash-tagged org/metric/period counter plus operation record; atomically compare request identity  |
| step_up_token:jti                                    | replaced by durable tenant step_up_receipts for single-use mutation; Redis must not consume authorization                            |
| dpop_jti:jti                                         | platform login replay namespace + provider/session binding; tenant agent replay includes org/credential identity                     |
| configured rate-limit prefix                         | platform IP/login throttle remains global; authenticated tenant throttle includes org + actor, no capacity borrowed from another org |
| RedisLock caller-supplied key                        | runtime tenant callers require org/task/attempt binding; scheduler-only lock uses explicit platform namespace                        |
| Bull recalculation/status/email/webhook/Slack queues | prefix tenancy-v1; job ID orgUUID_eventUUID, action ID includes task UUID; all payloads version 1                                    |
| expiration sweep repeatable job                      | platform metadata scheduler only; enumerate org IDs then process bounded batch under each context                                    |

## File ownership and handoffs

Ownership prefixes below are exclusive within a wave. Existing exact interface files are in inventory.md; existing task files retain their detailed tests. New cross-task interface declarations belong to B2; concrete services never move those declarations. Coordinator alone owns shared barrels, dependency pins/lockfiles and root modules after task outputs are ready.

| Task | Exclusive implementation paths / new contracts                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | db-migrations, generated Prisma/schema, migration constant, database role init                                                                                 |
| B2   | domain src/tests, all service interfaces, shared tenant/context types; move login-facing user service interface to auth/interfaces before E                    |
| B3   | API repository specification, validators, tests, mocks, generated artifacts                                                                                    |
| C1   | database-client, transaction-context, transaction-manager, new platform capability adapters, app/test tenancy helpers                                          |
| C2   | external/kms and crypto tests; TenantEncryption + PlatformEncryption implementation                                                                            |
| C3   | SDK client/auth/interfaces/tests; package pin coordinated                                                                                                      |
| D1   | user, user-identity, organization-admin replacements; agent/challenge, refresh, PKCE; new account/session/membership/invitation/receipt/directory repositories |
| D2   | group/group-membership/space/template repositories; shared/user-operations and shared/json-mappers modifications are assigned here and supplied at barrier     |
| D3   | workflow/vote/task repositories, outbox/dispatch/event-receipts/lease adapters                                                                                 |
| D4   | quota/usage/audit repositories, platform-security and durable usage adapters                                                                                   |
| E1   | services/auth, main/auth, auth controllers/providers/decorators; public/internal health and ping                                                               |
| E2   | user/agent/organization-admin/role services and controllers; new organization/membership/invitation/lifecycle/recovery modules                                 |
| E3   | group/group-membership/space/template/hierarchy/resource-resolution services/controllers, internal template route replacement                                  |
| E4   | workflow/vote/recalculation services/controllers                                                                                                               |
| E5   | queue/task/webhook/Slack/email dispatch orchestration, worker processors, Redis dispatch lease adapter, outbound SSRF                                          |
| E6   | quota/usage/audit/feature-gate services/controllers, Redis quota client; existing organizations controller entitlements/usage methods only                     |
| F1   | frontend repo, including mocks/router/auth/cache and Playwright                                                                                                |
| F2   | CLI repo, preserving recorded staged baseline                                                                                                                  |
| F3   | new tenancy integration suites and tenancy fixture corrections only                                                                                            |
| F4   | deploy/scripts/docs/operator commands, excluding B1's completed migration/role assets                                                                          |
| G1   | version manifest, final verification report and explicitly assigned corrections                                                                                |

E2 creates separate organization lifecycle controller files; E6 retains the current organizations controller file for summaries, preventing an ownership overlap. E3 calls E6 quota port and E4 recalculation port through frozen interfaces, never edits those peer implementations. E5 uses E4 recalculation and E2 lifecycle ports; typed fakes are permitted only for the peer service, while D persistence is real at integrated E gate.

At the B barrier, compile generated API exports and domain/ports in isolation. At C test contextual DB pools, crypto substitution and SDK. At D test every adapter with actual restricted roles. At E compile both backend/worker and run real integrated providers. F adds adversarial browser, CLI, isolation and deployment cases. G rehearses the complete artifact set. No model assignment changes these gates.
