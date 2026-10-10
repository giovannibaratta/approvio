# ADR 010 low-level design

Status: proposed implementation baseline. Wave A records any deviations and freezes exact interfaces. No unresolved security requirement may be weakened by an implementation shortcut.

## 1. Verified starting points

- `prisma/schema.prisma`: User owns email, roles and identities; OrganizationAdmin links by email; no Organization model. Space/Group/Agent/Workflow names are globally unique; templates use (name, version). Votes cascade from users/agents.
- `app/external/src/database/database-client.ts`: `cx` falls back to unrestricted Prisma; AsyncLocalStorage carries transaction client/isolation only. Existing retries include broad transaction errors; repository error mapping can hide retryable errors.
- `app/main/src/auth/jwt.strategy.ts`: retrieves current user by identifier and agent by name, prefers access-token cookie to bearer. Tokens lack organization context.
- `app/services/src/queue/interface.ts`, `app/external/src/queue/queue.provider.ts`: recalculation carries workflowId only; Bull task deduplication is queue-retention based.
- `app/services/src/vote/vote.service.ts`: eligibility and persistence are intentionally optimistic; publication is best-effort.
- `app/external/src/kms/encryption.service.ts`: encrypt/decrypt do not pass or verify tenant binding.
- `app/services/src/usage-metering/usage-metering.service.ts`: reservation/settlement exists; some reads still use DEFAULT_ORG_ID. Quota schema lacks owning organization.
- Sibling checkouts exist: `/workspace/approvio-api` (OpenAPI/validators), `approvio-ts-sdk` (clients/authenticators), `approvio-cli` (commands/config-manager), `approvio-frontend` (App.tsx, store/authSlice.ts, services/api.ts).

Re-inventory baseline drift in A1. The ADR's compatibility experiment is evidence about mechanisms, not an application isolation test.

## 2. Proposed product defaults

| Topic | Launch choice |
| --- | --- |
| Onboarding | Explicit create-organization action after login; zero memberships shows onboarding. No first-login shared workspace. |
| Addressing | Opaque UUID organizationId in API/frontend paths; immutable lowercase ASCII slug for display/discovery, 3–63 characters, letters/digits/internal hyphens. Reserve slug and UUID forever. Display name is editable and non-unique. |
| Resource names | Preserve current resource-name validation/case rules; uniqueness becomes (orgId, name). Workflow-template revisions are unique by (orgId, name, version), retain immutable UUIDs, and keep the existing name-based role scope within the organization. The organization path makes the same template name reusable across organizations; no separate template-family entity is introduced. |
| Human authority | Organization-local User id is attribution identity; Account id is login identity. Multiple owners; owner grants/removes owners, manages lifecycle and all org resources. Admin manages members/resources but cannot grant owner, remove/demote owner, or delete org. Member needs explicit roles. Agents cannot become owner/admin. |
| Recovery | Prevent last-active-owner removal/demotion/leave under a transaction lock. Self-hosted recovery is an explicit operator command naming org and account IDs, audited as operator; no global email-admin allowlist. SaaS owner recovery is an explicit audited operator procedure, not a customer-data bypass. |
| Invitations | Account-bound invitation link: owner/admin selects exact platform account ID, recipient authenticates that same account and accepts a single-use expiring token. No global account-search endpoint; recipient can share their account ID from profile. Default expiry 7 days. Email invitations and identity linking are deferred. |
| Suspension | Block tenant resource reads/writes and new dispatch; allow current owner/admin minimal org status, membership/owner recovery, entitlement/usage summary and remediation endpoints. Security/abuse suspension can only be lifted by an authorized operator. Owner-requested pause can be resumed by an owner. |
| Deletion | Owner step-up marks deleting, immediately blocks tenant access/new execution, invalidates org credentials, retains tombstone and payload pending retention policy. No resume from deleting/deleted and no automatic physical purge. |
| Grace period | No payment automation now. Persist reason and optional graceUntil; grace is active access until a due, idempotent lifecycle transition suspends it. Operators set policy explicitly; no assumed duration. |

These defaults resolve open ADR choices for planning. They are not existing product requirements. A1 must record changes before downstream schema/client work starts.

## 3. Persistence model

Use UUID resource IDs independent of organization placement. Tenant rows have non-null immutable `organization_id`, an FK to organizations, and indexes starting with organization_id for tenant lists. Existing UUID primary keys may remain; add unique (organization_id, id) for referenced parents.

Login providers remain deployment-configured for this ADR. Persist their stable configuration keys; do not rename or reuse a key for another issuer. Provider administration and organization-specific SSO are deferred.

| Model/table | Fields and integrity |
| --- | --- |
| organizations | id, slug unique, display_name, status active/suspended/deleting/deleted, suspension_reason, grace_until, occ, timestamps. Keep UUID/slug tombstone. |
| platform_accounts | id, display_name, profile email (not globally unique identity proof), status, timestamps, occ. No tenant roles. |
| platform_account_identities | account_id, provider_id, validated issuer, subject; unique (provider_id, issuer, subject). Never join accounts by email. |
| users (organization membership) | id, organization_id, platform_account_id, status active/removed, org_role owner/admin/member, roles, display snapshot, occ, timestamps; unique (organization_id, platform_account_id). Remove login-identity and global-email constraints. Re-admission reuses local id but clears old role/group authority. |
| organization_invitations | id, organization_id, target_account_id, token_hash unique, expires_at, accepted_at/revoked_at, proposed explicit grants, inviter local id, occ. Accept validates tenant, target, lifecycle, current inviter authority and grants. |
| users discovery index | `(platform_account_id, status, organization_id)` supports account discovery through active local memberships. Join the organization directory for current display/status; do not duplicate membership state. |
| browser_sessions | id, account_id, provider_id, selected_org_id nullable, context_version, status, expires_at, occ. Selected org conveys no authority. FK to organization directory only. |
| refresh tokens / PKCE | Platform auth records bind account, provider, session/family; PKCE also pins intended org and context version for targeted step-up. Split agent refresh storage into tenant-owned table. Store hashes; preserve rotation/reuse detection. |
| agents/challenges | org binding on both; agent UUID is token subject, name unique within org; status active/revoked; challenge binds agent, org, nonce, expiry and use state. |
| spaces/groups/group memberships/agent memberships | organization_id on every row, composite tenant FKs for all parents. Memberships reference local users, never accounts. |
| workflow_templates/workflows | each template revision owns org + space and is unique by (org, name, version); workflows reference a revision with a composite tenant FK. JSON approval/action references must be checked in services. |
| votes | org + workflow + local user/agent composite FKs; exactly one voter CHECK. Preserve removed/revoked principals, replace user/agent cascade deletion with restrictive history-preserving behavior. Group attribution remains a snapshot; validate all group IDs at vote time. |
| email/slack/webhook task tables | org + workflow composite FK; stable task identity, task state, claim lease/fencing counter, initiating actor snapshot, dispatch attempt records. Unique task generation key (org, transition event, action index/type). |
| tenant_outbox | id/event_id, org, event_type, resource_id, resource_version, schema_version, payload, available_at, lease_until, lease_owner, published_at, attempts; unique durable event identity. |
| dispatch_attempts | org, task_id/type, attempt id, fencing counter, state admitted/sending/succeeded/failed/unknown, sanitized result/timestamps. Ensure task-type relationship cannot point to another org; concrete schema chosen in A1. |
| quotas | org, scope/type/target, limit, occ; unique (org, scope, quota_type, target_id). Polymorphic targets validated contextually; org scope target must equal org ID. |
| usage_events | org billing owner independently of resource/actor; unique (org, event_id), immutable fact payload. Duplicate ID with different fact is an error. |
| audit_logs | non-null org, actor type/id and snapshot, entity snapshot, timestamp/payload; no cascading history FK to actor/resource. Tenant-leading indexes; preserve ADR 003/004 retention/index strategy. |
| platform_security_events | separate platform scope for login/security/operator events; no fabricated org. Org lifecycle/recovery additionally emits tenant event with actual operator attribution. |

A1 produces a table-by-table FK/delete/index/RLS matrix including every current model and all new records. Platform metadata is accessed through narrow platform ports. An account discovery index is the only global membership listing surface; tenant IAM remains authoritative.

## 4. Database context and isolation

Service-facing ports (exact exported names frozen in A1/B2):
- `TenantContext { organizationId }`; authenticated tenant principal includes this, local user or agent, current authority, and authentication evidence.
- `TenantTransactionManager.execute(context, computation, options)` returns TaskEither. It starts a bounded transaction, sets context, executes DB-only work and rolls back on Left.
- Separate `PlatformIdentityRepository`, `OrganizationDirectoryRepository`, `AccountDiscoveryRepository` and `TenantRepository` capabilities. No generic `skipTenantCheck`.
- AsyncLocalStorage stores org ID, transaction, isolation level. Same-org nesting reuses the client; mismatched org or stronger nested isolation fails. `tenantCx` throws without established scope; no root fallback.
- Set a parameterized transaction-local `set_config('app.organization_id', orgId, true)` before tenant queries on every attempt. Establish validated account/session scope separately for platform operations.
- Tenant policies use both USING and WITH CHECK with `organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid`. Missing setting cannot expose tenant rows. Invalid UUID is rejected at boundary; database malformed setting fails.
- ENABLE and FORCE RLS on every tenant table. Runtime roles have no SUPERUSER/BYPASSRLS/DDL/TRUNCATE privileges, cannot become migration role, and are not table owners. Migration credentials are separate. Audit/usage roles have append/read only as appropriate.
- Composite FKs enforce tenant matching even on direct SQL writes. RLS alone does not constrain parent ownership. Prevent organization_id updates with column privileges or a narrow immutable-ownership trigger, including privileged maintenance test coverage.
- Platform account/session reads are account-scoped through dedicated adapters. Pre-login identity resolution permits only a validated provider/issuer/subject lookup. Directory scheduler lists minimal org IDs/status only; it must then open a tenant transaction per org. Tenant repositories are never given platform connection capabilities.
- Organization creation uses an explicit account-authorized provisioning transaction: insert directory row, set newly generated org context, insert owner and discovery index atomically. It grants no generic bypass.
- Platform discovery projection mutations for org-member administration use a narrow repository method in the same DB transaction, scoped to the supplied org and target account. Do not expose arbitrary platform account writes to tenant services.

Retry the entire outer DB computation on confirmed serialization/deadlock or explicit OCC conflict, with bounded exponential backoff/jitter and an exhaustion domain error. Default 3 total attempts, 25ms base/250ms cap; configuration may tune later. Preserve retryable errors through repository mapping. Do not blanket-retry every P2028 or ambiguous commit outcome. External HTTP/email/KMS/Redis work is outside replayed database callbacks; precompute encrypted blobs where needed. Outbox writes join the DB commit.

PostgreSQL documents the RLS role exceptions and independent integrity checks in [row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html). Prisma documents whole-transaction retries for P2034 in [transactions](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions). Test the installed versions; do not rely on nested Prisma extension callbacks to establish scope.

## 5. Authentication and API contract

All tenant-facing API paths start `/o/:organizationId/...`, including users, groups, agents, roles, spaces, workflow templates, workflows/votes, audit, quotas, resource resolution and tenant capabilities. Internal-only operations remain under `/internal/*` and derive organization context from the authenticated tenant principal. Public/global allowlist: health, provider list, login/callback/refresh/logout, own account, own discovery, create organization, session context switch. Organization-targeted agent authentication and step-up routes are qualified too; global auth routes never grant tenant data access.

Proposed endpoints: GET /account; GET /organizations (own discovery); POST /organizations; POST /auth/web/select-organization {organizationId} with `If-Match`; GET /auth/web/session (own selected context with `ETag`); tenant organization status represented by GET /o/:organizationId, with membership/invitation/lifecycle routes under that same tenant prefix. Conditional HTTP mutations use opaque ETags, not persistence counters. Freeze full operation mapping in A1/B3; no compatibility aliases to implicit tenant routes.

Access credentials are discriminated platform-user, tenant-user, tenant-agent variants. Tenant-user binds accountId, local userId, organizationId, providerId, sessionId and browser occ where applicable. Tenant-agent sub is UUID and binds org/credential identity. Platform token can only use global capabilities. Signed org claims must equal path; headers cannot select a different tenant. Never trust JWT roles as current authorization.

Every tenant request validates current session/principal/membership and lifecycle from authoritative storage after authentication. No authority cache at launch; committed revocation is observed by a newly admitted request. Fail closed on unavailable authority storage. Wrong tenant resource IDs return 404; absent membership also returns non-enumerating 404. Invalid/revoked credential is 401. Authenticated stale browser path/context returns 409 ORGANIZATION_CONTEXT_CHANGED before mutation; recognized suspension returns 423 ORGANIZATION_SUSPENDED only to authorized members. Business permission denial is 403.

Browser context switch locks/CAS-updates only that browser session, validates target membership, increments occ, and returns replacement HttpOnly credentials. All cookie requests compare session version/selected org with path and claims; this includes A→B→A changes. In-flight request admission is the concurrency point; sensitive writes recheck in their transaction. Late refresh/switch responses cannot silently restore stale context: stale versions are rejected, refresh uses latest authoritative session state, and UI reloads session on mismatch. Other device sessions and CLI credentials remain valid.

Preserve Secure/HttpOnly/SameSite protections, explicit CSRF/origin validation for cookie mutations and refresh-family reuse detection. Broaden refresh-cookie path only as needed for authenticated switch, and test cookie path behavior. Step-up binds provider + session version + org + operation + resource + single-use ID; changing org invalidates its use. Login and refresh never merge provider identities by email.

This deliberately amends ADR 001's stateless session-lookup claim; JWT transport remains. Future enterprise accounts use separate org-owned tables and trust-scoped authenticators, with explicit enrollment to a local user; no enterprise enrollment endpoint ships now.

## 6. Authorization concurrency and lifecycle

JWT authentication loads the current account, session, membership or agent once and installs that entity as the requestor. The tenant guard matches the route organization to that requestor; the admission guard checks current organization lifecycle using the same requestor. A request admitted before a concurrent revocation may finish; later requests observe the committed revocation. Do not reload the requestor or acquire an organization lock solely to close that in-flight window.

Mutations run in a tenant transaction, validate the authenticated requestor against the relevant current domain configuration, and persist changes and audit/outbox records atomically. Use operation-specific concurrency controls when needed to protect a concrete invariant, such as the last active owner or single-use step-up receipt. Do not use an organization-wide lock as a general authorization refresh mechanism.

Voting validates the authenticated requestor's roles and group memberships against workflow/template state and step-up requirements inside the tenant transaction; persist the vote, audit and recalculation outbox atomically. Single-use step-up consumption must be durable in the same commit (add a tenant receipt table if the existing Redis provider cannot participate); no Redis decrement/consume inside transaction retries.

Removal tombstones local user, clears roles/groups and discovery, and denies new requests. Re-admission explicitly grants new roles/groups; history and local user ID remain. Revoke agents rather than cascade deleting historical voters. Existing committed org tasks retain attribution and do not require initiator membership unless an action explicitly declares personal-authority execution.

Dispatch admission reads status before claim and again before marking work as sending, without locking the organization row. If either read sees a non-active status, park the work. If suspension is still uncommitted, the worker may see the old active status and proceed; this race is accepted. There is no claim of recall or an atomic DB/network boundary. Completing the record for an already-started dispatch is allowed under a restricted reconciliation operation while suspended/deleting.

That reconciliation capability also permits immutable usage/audit settlement for already-admitted work; it cannot create a new external invocation or restore member access. Ordinary tenant callers cannot request it. Directory lifecycle status and tenant admission must read the same authoritative organization row, not rely on a stale discovery projection.

Resumption runs bounded tenant reconciliation: expire overdue workflows first, re-evaluate stale task eligibility, republish eligible pending outbox/tasks. Deadlines do not shift. Deletion blocks new dispatch/access even before later retention/purge work.

## 7. Workers, durability, fairness and external calls

Persist event/outbox together with mutation. Relay enumerates active org IDs via directory metadata, leases a bounded batch inside each tenant context, publishes outside the DB transaction and marks publication afterward. Crash after publication may republish: correctness comes from durable consumer state, not Bull retention. Include {schemaVersion, organizationId, eventId, resourceId, resourceVersion}; action envelopes add taskId. Queue payload identifiers must match stored org/task/workflow ownership before processing.

Stable task generation key includes org + workflow transition event + action index/type. Recalculation events need revision/event identity so a retained Bull job does not suppress later votes. Redis keys/job IDs use a tested Bull-safe encoding such as `orgUUID_eventUUID`; taskId remains the webhook Idempotency-Key without a tenant prefix.

Task claim transitions ready→claimed→sending→succeeded / retry_due / failed / unknown / paused. Store lease owner/expiry and monotonic fencing value; stale claimant cannot overwrite current state. Reclaim expired leases; unknown external outcome requires receiver-idempotent replay or explicit reconciliation, not blind redelivery. DB status fencing cannot itself prevent duplicate external effects.

### OCC and lease fencing

`occ` and `fencing` are both monotonic, but they represent different concurrency
domains:

- `occ` is the durable row version. Every mutation of the durable work row,
  including claim and reclaim, advances `occ`. A caller supplies the version it
  read; an update succeeds only when that version is still current.
- `fencing` is the lease-generation token. Each new claim or reclaim advances
  it and gives the worker a lease epoch. Lease-protected writes must match the
  current fencing value, owner, and unexpired lease. A worker from an older
  epoch therefore cannot complete or overwrite work after its lease is lost.

Example: a claim can advance both values, but a lease reclaim creates a new
fencing epoch even when no business payload changed. OCC answers “did this row
change?”; fencing answers “is this operation from the current lease holder?”.
They must not be substituted for one another.

Fencing does not stop a worker already executing an external request. Lease
expiry cannot recall an in-flight network call. The task state machine therefore
does not blindly reclaim `sending` work; ambiguous external outcomes become
`unknown` and require downstream idempotency or explicit reconciliation before
another attempt. Fencing protects the database transition, not exactly-once
external delivery.

Retain transient-only webhook retries, immutable taskId Idempotency-Key, SSRF/egress checks on resolved destinations and redirects, response limits/redaction. Email and Slack may lack receiver deduplication: record ambiguous delivery as unknown and require explicit reconciliation; do not promise exactly-once delivery. Permanent failures terminate. Preserve request-specific credentials/destinations within org encryption context.

Bound per-org simultaneous dispatch through atomic Redis leases keyed by org and task/attempt, default 4 in flight (configurable); use renewal, expiry and owner-token release. Fail closed if admission storage is unavailable. Fair round-robin bounded outbox scanning (default 100 per org per pass) prevents a large org monopolizing publication. Paused tasks live durably in DB and are not hot-loop retried in Bull. Two-org saturation tests must demonstrate small-org progress; no throughput SLA is assumed.

Dispatch admission also counts live persisted `claimed`/`sending` leases and claims the next task in
one Serializable transaction. This guards the same configured cap when Redis loses its slot state;
collisions retry the whole database computation. Redis remains required for admission and renewal.
This bounds live leases and does not recall an external call that outlives its lease. The database
and Redis lease durations share configuration, and a processor checks both immediately before egress.

## 8. Quotas, audit and encryption

All quota, feature-gate, hierarchy and usage calls require trusted orgId. Validate measured resource ownership independently of billing owner and actor. For cardinality/concurrent-workflow admission, lock org/quota scope and count+create in the same transaction; resource service invokes the frozen quota port inside its transaction. This updates ADR 009's tolerated count races.

Keep metered Redis admission, but reservation identity is (org, metric, billing period, operationId). Repeated reserve/settle/cancel must be idempotent and reject mismatched amounts/owner. Durable settlement event precedes cache settlement; retain recoverable settlement intent and reconcile cache outages. Never treat another tenant's ledger/cache as fallback capacity.

Tenant audits record org and actual local actor/operator with immutable snapshots. Global account/security events go to separate platform storage. Cross-org audit reads, /me filters, aggregate usage and resource resolution are tenant-qualified. Repositories map FK/unique failures to non-enumerating errors and redact raw DB details.

Encryption port requires {organizationId, resourceType, resourceId, field, formatVersion}; serialize authenticated context into ciphertext and compare on decrypt before returning plaintext. Keep key/format version metadata; reject missing or different binding. Use the existing supported keyring backend, not new per-org KMS infrastructure. A1 fixes template version copy semantics: decrypt source with source resource ID and re-encrypt for new immutable template/task ID. No ciphertext copying across orgs/resources. Raw secret values/URLs/payloads are excluded from logs and routine support telemetry.

## 9. Migration and release

B1 owns all tenancy migrations and DB role/grant definitions, including new schema required by session receipts, outbox, attempts and reconciliation. Use forward Liquibase migrations, not edits to applied history; introspect/remap/generate Prisma. Existing nonempty tenant tables cause a clear migration precondition failure; no inferred owner/backfill. Fresh DB and explicitly disposable reset are supported; preserving development data needs a separate explicit mapping/export task if requested.

Stop API/workers for cutover. Use deployment-specific queue/cache namespace version, invalidate old sessions/agent credentials and require reauthentication/re-registration. Old jobs without org/schemaVersion are quarantined, not guessed. Deploy compatible contract→SDK→backend/worker→frontend/CLI artifacts together, with package pins and schema/config checks. Before any reset, identify target environment and require its explicit disposable designation.

Rollback after new writes is forward repair or restoration of the complete pre-cutover disposable snapshot with matching code/queues; never run old code against the new schema. Separate migration and runtime credentials in dev/test/deploy. G proves RLS using the actual restricted runtime role and small connection pool, not a superuser test shortcut.
