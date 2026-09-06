# ADR 010: Technical Decision Notes

**Date:** 2026-09-06

**Purpose:** Answer the review discussion with verified compatibility evidence and trade-offs. The [ADR](./010-multi-organization-tenancy.md) remains the high-level design; these notes explain the adopted decisions and their trade-offs.

## 1. Scope established by the discussion

Organizations represent separate customers. Users and permissions span spaces inside that boundary. Cross-customer resource sharing and transfer are excluded. SaaS initially uses platform login providers; self-hosted supports operator-configured OIDC. Organization-specific SSO, cells, and their operations tooling are future capabilities.

There is no default organization. Its only purpose in the earlier draft was automatic initial setup and compatibility with today's hardcoded identifier. Neither requires a special organization: onboarding can create an ordinary organization with explicit ownership. Automatic versus explicit creation is a product decision.

The adopted model combines platform social login accounts with separate organization memberships, and future organization-owned enterprise accounts. Both resolve to organization-local users for authorization and attribution. Platform recovery cannot be delegated to a customer IdP. Enterprise SSO enrollment must explicitly handle an existing social-login membership; email equality alone cannot authorize that transition.

## 2. Database constraints versus application enforcement

The required rule is independent of storage technology: all tenant-owned resources and relationships stay within their organization. The enforcement trade-offs are:

| Mechanism | Protection | Cost and limitations |
| --- | --- | --- |
| Application-scoped resolution and validation | Checks membership, role permissions, tenant ownership, and JSON references with domain-specific errors. | Every read/write path must comply, including jobs, bulk operations, raw SQL, and future import/repair tools. Missing validation can produce durable invalid relationships. |
| Tenant-matching composite foreign keys | Atomically reject cross-organization relational links, even when application validation is bypassed. | Additional constraints and supporting unique indexes; write/storage overhead; persistence mapping and migration work. Does not validate arbitrary JSON or authorize a person. |
| RLS using transaction context | Rejects or filters ordinary reads/writes outside the selected organization when a predicate is omitted. | PostgreSQL-specific policies, restricted roles, transaction lifecycle discipline, and query-planning/transaction overhead. Does not prove membership or automatically enforce matching organizations across relationships. |

**Adopted decision:** Keep authorization in the application and require tenant-matching relational constraints plus RLS. Their distinct protections justify the additional persistence and transaction discipline.

Composite foreign keys are standard relational concepts; their removal does not by itself make a future non-relational migration easy. A different database may require different transactions, indexes, queries, and consistency mechanisms regardless. The useful portability boundary is an explicit tenant-aware repository/unit-of-work contract whose guarantees a new adapter must preserve.

Application-only enforcement is technically possible. With immutable organization ownership, a validated parent cannot silently move to another customer between validation and use. However, that does not protect against a missing check or a path that supplies a foreign ID directly. Standard FKs can still cover existence/deletion races; current authorization and mutable parent properties require their own concurrency rules.

An isolated compatibility check made the trade-off concrete: a tenant-A association referencing a tenant-B group was accepted with simple FKs and RLS. Adding composite tenant FKs rejected the same Prisma operation with `P2003`. Database reinforcement therefore catches a distinct error that the application-only option would rely on code and tests to prevent.

Exact constraint selection belongs in the low-level schema design. The HLD requires both enforcement mechanisms.

## 3. What FORCE RLS means

PostgreSQL distinguishes the table owner, ordinary runtime roles, and privileged roles:

| Role | ENABLE RLS | ENABLE + FORCE RLS |
| --- | --- | --- |
| Ordinary runtime role without bypass privileges | Policies apply | Policies apply |
| Non-superuser table owner | Normally bypasses policies | Policies apply |
| Superuser or role with BYPASSRLS | Bypasses policies | Still bypasses policies |

The table owner retains DDL authority, so `FORCE` does not make that owner an untrusted party. Use separate migration/owner and restricted runtime credentials. PostgreSQL handles transaction-local setting cleanup on commit/rollback; session-level tenant settings must not be used. [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), [SET semantics](https://www.postgresql.org/docs/17/sql-set.html)

This adds database policies and a credential/transaction contract, not a new running service. Liquibase's SQL change support can maintain the policies. Prisma can query the tables through the restricted connection even though its schema language does not model the policies. `db pull` reports the unsupported schema feature and leaves the policies in PostgreSQL; Liquibase remains their source of truth. Compatibility was checked with Prisma 7.9.1, PostgreSQL 17.4, and Liquibase 4.31.1; application integration remains follow-up work. [Liquibase SQL changes](https://docs.liquibase.com/reference-guide/change-types/sql)

## 4. Revocation: what performance buys and what it gives up

JWT cryptographic validation and authorization freshness are separate. A token can have an hour lifetime while a current-state check rejects it immediately after membership removal. Conversely, removing a refresh token does not stop an already-issued access token when the API checks only its signature and expiry.

| Approach | Residual access after removal | Work on request path | Failure/operational trade-off |
| --- | --- | --- | --- |
| Token-only authorization; one-hour TTL | Up to the remaining hour, assuming renewal is denied after removal. | Local signature/claims validation. | Authorization continues during state-store outages, but a departed admin can retain full token authority during the window. |
| Shorter token-only TTL | Up to the remaining shorter lifetime. | Local validation plus more frequent token renewal. | More renewal traffic and dependence on renewal availability; still no immediate revocation. |
| Current-state authorization | Requests admitted after committed revocation are denied when checked against authoritative current state. | Indexed state lookup, potentially combined with principal loading. | Adds database work/latency and fails closed when current authority cannot be established. In-flight operations need defined concurrency semantics. |
| Bounded authorization cache | A deliberately bounded stale-state window; invalidation can usually shorten it. | Cache lookup or local cached check; database on misses. | Less database load, but invalidation, cache-fill races, freshness timestamps, and failure behavior must be designed. |

**Adopted starting point:** Keep the existing per-request principal lookup and make it organization-aware, including organization status and current permissions. [JwtStrategy](../../../app/main/src/auth/jwt.strategy.ts) already retrieves users/agents. This is an incremental extension of current behavior; no centralized authorization service or Redis cache is necessary initially. It is not a claim of zero extra database work or a measured latency guarantee.

If load measurements later show this is significant, a cache window of, for example, 15–30 seconds can be evaluated as a product/security trade-off. Those values are discussion examples, not an adopted TTL. Sensitive mutations such as voting could retain authoritative checks while less sensitive reads use the bounded cache. Define what each category permits during the residual-access window.

A cache TTL must bound the age of the **authoritative state**, not merely the age of a cache entry. Repeated sliding expiry, lagging replicas, or an old in-flight lookup repopulating an invalidated entry can violate a naive bound. Pub/sub invalidation accelerates propagation; it cannot alone guarantee all instances received an event. On miss or uncertain freshness, reload authoritative state or deny.

### Industry evidence

OAuth token introspection explicitly models querying whether a token is currently active. Its security discussion describes the trade-off between caching introspection results and learning about revocation. This is a standards-backed alternative to treating JWT contents as permanent authority. Approvio does not need to deploy an introspection service to apply the same current-state principle. [RFC 7662, section 4](https://www.rfc-editor.org/rfc/rfc7662.html#section-4)

Microsoft Entra's continuous access evaluation uses critical-event propagation so supporting resource services can reject unexpired tokens. Microsoft documents possible propagation delays up to 15 minutes for those events; this is evidence of an explicit distributed trade-off, not a universal industry revocation guarantee or a recommended Approvio target. [Microsoft CAE](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation)

Reducing authorization staleness later is not a one-way door if requests already pass through one tenant-aware authorization boundary. Starting with token-only checks scattered throughout services would make that change harder. For an approval system with an existing lookup, an hour of post-removal voting authority is an avoidable initial compromise.

## 5. Browser switching and account ownership

An organization path establishes what the user intends to access. A scoped credential must agree with it. With the existing shared access-token cookie, switching from A to B can simply replace the current context; an older A tab is then rejected on mismatch and prompted to update its view.

Do not silently switch back to A and replay a write. A notification between tabs improves UX but does not replace server verification. Any already-issued token remains subject to the normal revocation/expiry contract; selecting B is not the same as revoking A membership.

Invalidating every device/session on each switch would require more server state and could interrupt unrelated work. It is not the simplest safety measure. A single active context in one browser session is a reversible UX choice; simultaneous tabs can later use a different token/session arrangement. The external organization-qualified route contract can remain stable.

The adopted account model combines both scopes. A platform social account offers unified login and discovery for its organization memberships; a future enterprise account belongs to its organization and uses separate authentication and recovery. Organizations own permissions under both paths.

This can produce duplicate accounts and confusion during enterprise SSO adoption. Preserve an organization-local user for attribution, require an explicit enrollment process, and remove superseded login access under the organization's policy. Different providers asserting the same email is insufficient proof of identity ownership. Auth0 likewise treats provider identities separately by default and requires authentication for secure linking. [Auth0 account linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking)

Resource reassignment is independent of this choice. Organization-owned resources do not need a personal-resource recovery feature initially. If personal ownership is introduced later, an admin can reassign resources within the organization without controlling identities or resources elsewhere.

## 6. Keeping future cells and encryption feasible

The major choices that would make cells substantially harder are cross-tenant business transactions/references, tenant data without reliable ownership, implicit default context, and deployment hostnames embedded into durable identities. The revised model avoids those choices.

The HLD direction separates platform authentication and a minimal organization-routing/discovery directory from organization IAM in each cell. This can remain modular inside the monolith. Future cells must define trust, key rotation, session revocation distribution, and outage behavior; they should not require a synchronous global permissions lookup for every tenant request. Platform-wide identity may need regional storage and processing. Identity, membership indexes, logs, and support access must be included in residency analysis; a small global directory is not automatically exempt. See ADR section 9 for the placement boundaries and sources.

Immutable organization IDs, tenant-bound repository operations and job envelopes, independent entitlement attribution, and pause/resume semantics provide useful foundations. Actual migration will still need copy/catch-up, source write fencing, queue/lock/reservation handling, and recovery. An offline move is a valid initial operational implementation. The HLD should preserve feasibility rather than promise cheap or zero-downtime migration.

For encryption, scope only three foundations in this ADR: organization-aware secret operations, authenticated tenant binding in ciphertext handling, and key-version support. A global encryption interface that accepts only bytes hides the organization needed for future key selection and validation; the current [EncryptionService](../../../app/external/src/kms/encryption.service.ts) has that limitation. Exact key hierarchy, KMS/BYOK behavior, cache revocation, and rotation belong in ADR 006.

The original audit partition claim has been removed; per-tenant deletion cannot drop a shared hash bucket. The egress section retains tenant-bound credentials, destination policy, and SSRF requirements. Tunnels and dedicated IPs are useful possible deployment features, but neither provides isolation by itself, so their product/operations design is deferred.
