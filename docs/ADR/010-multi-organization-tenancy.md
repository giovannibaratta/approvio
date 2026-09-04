# ADR 010: Organization Tenancy and Isolation

**Scope:** Backend API, workers, API contracts, frontend, CLI, and SDK.

**Purpose:** Establish the high-level tenancy model and preserve viable paths to future deployment capabilities. Detailed schemas, interfaces, migrations, and operational protocols follow in the low-level design.

## Glossary

| Term | Meaning in this ADR |
| --- | --- |
| Customer | The person or business administering an organization. A person may participate in several customers' organizations without sharing their authority or data. |
| Organization / tenant | The same isolation boundary in this design. “Organization” is the product term; “tenant” describes its ownership and isolation in shared infrastructure. |
| Space | A resource container inside one organization, governed by that organization's permissions. |
| Login account | The identity used to authenticate a person. A platform account may access several organizations through separate memberships; an enterprise account belongs to one organization. |
| Membership / organization user | A person's presence and authority inside one organization, including local roles and group membership. Authentication alone does not establish this authority. |
| Identity provider (IdP) / SSO | An external authentication authority / single sign-on through that authority. A provider connection specifies which configured authority Approvio trusts. |
| IAM | Identity and access management: authentication, account lifecycle, memberships, and permissions. These responsibilities need not share one service or storage location. |
| Cell | An independently operated deployment of tenant APIs, workers, and data stores serving a subset of organizations. Several cells can occupy one region; a cell can serve one or many tenants. |
| Region / data residency | A geographic deployment area / requirements governing where particular data is stored, processed, or accessed. A region is not a tenant boundary. |
| Routing directory / control plane | Organization-to-cell placement metadata / administrative capabilities for provisioning and managing deployments. Neither grants access to tenant resources. |
| RLS / tenant-matching constraint | Database row-level security that restricts visible or writable rows / a relational rule that prevents links between different organizations. |

## 1. Context and requirements

Approvio currently implements an implicit single organization: service paths use `DEFAULT_ORG_ID`, administration is global, and resource names are generally unique across the database. Organizations are not yet first-class persisted entities.

Approvio is pre-production, with no customer installations that this change must preserve. The implementation may refactor existing models and introduce breaking changes across clients and services.

The first multi-tenant release must support:

- **Hosted SaaS:** Independent customer organizations sharing a deployment. Login providers are configured by the platform; customer-specific SSO is deferred.
- **Self-hosted:** The same organization model, with operator-configured login providers. Deployment-wide custom OIDC configuration already exists. Organization-specific provider policies can follow later.
- **Customer isolation:** A customer cannot read, change, reference, or administer another customer's resources. Multiple memberships never combine authority across organizations.
- **Future evolution:** Tenant data and execution have clear ownership so that dedicated deployments, regional placement, and cells remain feasible. These capabilities do not need implementation or an operations control plane now.

This ADR establishes the tenancy boundary, shared-table storage with database reinforcement, per-request authorization checks, and the account model. Detailed operational and product behavior follows from these decisions.

## 2. Organization as the customer boundary

An **organization** is the top-level customer boundary for data access, administration, entitlements, usage attribution, and lifecycle management. Organizations are peers; there is no organization hierarchy or cross-organization sharing in the initial scope.

**Spaces** partition resources within an organization. Users and groups can operate across its spaces according to permissions. Future enterprise segmentation must remain subordinate to the customer boundary; this ADR does not introduce another intermediate layer.

Every tenant-owned resource belongs to exactly one organization. Ownership is immutable during ordinary operations. Sharing or transferring resources between organizations is outside the initial scope. Moving between deployment cells would preserve the owning organization and resource identities.

All references between tenant-owned resources must remain within their owning organization. Knowing an identifier does not authorize its use. An organization supplied by a client is a requested context, not proof of access.

### Ownership classification

| Data | Required scope |
| --- | --- |
| Spaces, groups, agents, templates, workflows, votes, action tasks | Explicit owning organization; relationships remain within that organization. |
| Organization users or memberships, group membership, role assignments, invitations | Authority is local to one organization and may span its spaces. A shared login account identifies the person; each organization independently owns their membership and permissions. |
| Quotas and usage events | Explicit owning/billing organization, separately from the measured resource and initiating actor. |
| Tenant audit records | Organization attribution survives resource deletion and member departure, subject to retention policy. |
| Secrets, jobs, caches, locks, deduplication and reservation state | Organization ownership is preserved wherever tenant data is stored or executed. |
| Authentication sessions and provider connections | Explicit principal and provider trust scope, plus target organization where applicable. |
| Platform metadata and security events | Explicit platform scope; platform capabilities do not implicitly grant customer-data access. |

All tenant-owned database entities receive an organization binding. Global/platform records are deliberately classified exceptions, rather than records assigned to a default organization. Platform login accounts are platform-scoped; enterprise login accounts are organization-owned, as defined in section 4.

Resource names are scoped within the owning organization or a narrower container. Stable identifiers remain unambiguous independent of names and deployment location. Exact template-family/version naming and permission identifiers belong in the low-level design.

## 3. Storage and enforcement

### Storage decision

The initial model is a **shared PostgreSQL database with shared tables and explicit organization ownership**. This supports one migration stream and the same application model for SaaS and self-hosted deployments. At launch, Approvio has neither a requirement for separate customer databases nor the tooling to provision, migrate, monitor, and recover a fleet of them. Shared tables avoid that fleet overhead and pool connections and capacity across tenants. Explicit organization columns also make ownership visible to application validation, relational constraints, and RLS.

The trade-off is shared capacity and a shared failure domain: RLS protects row access, not CPU, connection pools, or backup isolation. Tenant-specific restore and heavy-neighbor control require additional mechanisms. Schema-per-tenant would retain much of that infrastructure sharing while adding migration and routing complexity.

| Alternative | Main benefit | Main cost and disposition |
| --- | --- | --- |
| Database per organization | Stronger database separation; independent backup/restore and placement options. | Provisioning, connections, and migration orchestration across databases. Dedicated compute is a separate choice. Retained as a future option. |
| Schema per organization | Separate table namespaces within PostgreSQL. | Repeated schema migrations and dynamic schema/client routing; still shares database infrastructure. Not selected initially. |
| Shared tables with organization binding | One schema, efficient shared infrastructure, explicit tenant data model. | Every access and relationship must preserve scope; tenant restore and capacity isolation need application/operational support. Selected initial model. |

**Upgrade path:** Keep shared tables as the short- and medium-term storage model. When measured capacity, failure isolation, or residency requirements justify cells, distribute whole organizations among independent cells; each cell can retain this same schema and application. A large or contractually isolated customer can occupy a dedicated cell, or later use a separately routed database where justified. Cells address deployment placement and capacity; shared tables address storage inside a deployment. These decisions are compatible.

Adding cells still requires routing, provisioning, migration, and recovery tooling (section 9). Database-per-organization does not become mandatory when cells are introduced. No tenant-count threshold, throughput guarantee, or fixed deployment capacity is assumed.

### Application enforcement

Tenant-scoped operations require an established organization context. Repositories resolve identifiers inside that context and validate referenced resources before mutation. Authorization evaluates only the current organization's principal authority.

The contract covers lookups, lists, aggregates, nested relationships, bulk operations, raw SQL, and background work. Missing or inconsistent context fails closed. There is no fallback to `DEFAULT_ORG_ID`.

Immutable organization ownership reduces ambiguity between validating a reference and using it. The low-level design must still handle deletion, revocation, and concurrent mutations consistently.

### Database reinforcement and portability

Application scoping is required regardless of database technology. The initial implementation also requires:

- **Tenant-matching relational constraints** reject relationships whose parent and child belong to different organizations, including writes that bypass application validation.
- **PostgreSQL RLS** limits ordinary reads and writes to the transaction's organization, protecting against omitted scope predicates.

These address different mistakes. RLS does not itself require related rows to belong to the same organization. A simple parent foreign key does not establish that requirement either.

The preference is to keep business authorization in the application and avoid unnecessary database-specific logic. Composite foreign keys are relational integrity rules; RLS and transaction-local settings require a database-specific implementation. Their portability costs should be assessed separately.

**Decision:** Adopt both tenant-matching constraints for relational tenant links and RLS on tenant-owned tables initially. Application scoping remains responsible for business authorization and references that relational constraints cannot cover, such as identifiers inside JSON. Exact constraints and policy definitions belong in the low-level design.

A replacement database must preserve the isolation contract. Replacing enforcement mechanisms is persistence-layer work; it must not require redefining organizations, permissions, or worker ownership. For example, a database without PostgreSQL RLS would need an equivalent enforcement mechanism and new isolation tests; changing a connection string would not preserve these guarantees by itself.

### RLS compatibility boundary

RLS uses a restricted runtime database role and an organization setting local to a bounded database transaction. The transaction boundary establishes context before queries, preserves it through nested operations, and re-establishes it on retries. External calls execute outside retried database transactions.

`FORCE ROW LEVEL SECURITY` makes a non-superuser table owner obey row policies. Superusers and roles with `BYPASSRLS` remain exempt. Liquibase can manage these policies as SQL migrations; Prisma need not represent them as application models. Runtime and migration roles must be separated. [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)

An isolated check verified these mechanisms using Prisma 7.9.1, PostgreSQL 17.4, and Liquibase 4.31.1. It also verified that Prisma query extensions do not receive separate nested-operation callbacks. A cross-organization relationship accepted with simple foreign keys and RLS was rejected after adding tenant-matching composite foreign keys. These checks establish mechanism compatibility; application transaction propagation, retries, and worker integration still require implementation tests.

## 4. Human identity, organization authority, and agents

Human permissions and organization-visible user records are scoped to a customer organization and can span its spaces. An administrator cannot administer a person's identity or resources outside that organization.

**Decision: Separate login accounts from organization-local users and support two trust scopes.**

- **Platform login:** In SaaS, a person using a platform-configured social provider has one Approvio login account and can discover the organizations in which that account has membership. Each organization independently grants and revokes access. “One login” does not automatically merge different social-provider identities.
- **Enterprise login (future SaaS capability):** An organization-specific provider authenticates a separate organization-owned account. It does not recover, take over, or expose the person's platform account or memberships elsewhere. Self-hosted operator-configured login remains local to that installation.

For example, Alice's platform account can have independent memberships in A and B. If C requires its own corporate SSO, Alice signs in to C with a separate enterprise account. C's administrator controls access in C only.

The shared concept is an organization-local user to which roles, groups, and approval attribution attach. Login identities authenticate that user; authority is never accumulated across accounts or organizations. Introducing enterprise SSO later needs an explicit enrollment/transition process to preserve the intended local user and history while retiring any disallowed social access. Matching email addresses must not silently merge identities. Account linking remains deferred.

The costs are separate recovery paths, possible duplicate accounts, and a more deliberate organization-discovery experience: a platform login cannot enumerate unrelated enterprise accounts. Platform-account compromise can affect all memberships reachable through that login, so account protection and recovery are platform responsibilities.

Under both account scopes:

- No request combines roles or groups from multiple organizations.
- Readmitting a removed member requires explicit regranting of roles and group access. Past approval attribution is retained; it does not restore authority.
- Agents are strictly organization-owned. Authentication, challenges, credentials, and permissions identify an unambiguous agent within its organization.
- Customer-created resources are organization-owned initially. Personal ownership and administrative reassignment may be added later without granting cross-customer authority.
- Administration can support multiple owners. The role design must define owner/admin powers and preserve a recovery path when owners leave; a single irreplaceable owner is not assumed.

### Authentication-provider boundary

Self-hosted operators may configure deployment-wide OIDC providers using the existing capability. Initial SaaS organizations use platform-configured providers. Customer-specific SSO, discovery, enforcement, and account linking are deferred.

Preserve the authenticating provider connection and any future organization-specific assurance requirement through sessions and renewal. An organization-owned provider must not gain global account authority simply by asserting an email. Stable external identity uses validated issuer/subject binding; email is not cross-provider account-linking proof. [OIDC claim stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)

Future organization-specific SSO can require fresh authentication for access to that organization. Explicit login endpoints and optional discovery must fit the same tenant authorization boundary.

## 5. Request context, sessions, and revocation

Every **tenant API and frontend route requires the organization in its path**. The backend validates the principal's authority for that organization. Any organization claim in a credential must match; headers cannot override the path or grant access.

Global entry points such as login and initial organization creation have no tenant data authority. Platform-account discovery exposes only that account's memberships; enterprise login starts from the target organization. Organization IDs/slugs are logical identifiers, not deployment hostnames.

The UI may hide an unnecessary switcher but retains organization-qualified routes. Switching never silently changes the target of a pending mutation.

### Browser switching

**Decision:** The initial UX presents one active organization per browser session. With a shared cookie, another tab holding an older context must receive an explicit context-change response or refresh its view before continuing. The server enforces mismatches; cross-tab notification is only a UX aid.

Change the current browser context without logging out all devices or revoking unrelated sessions. Global session invalidation adds coordination and does not remove the need to validate the path. Concurrent organization tabs can be supported later through session/token transport changes, provided request targeting remains explicit.

Switching changes the browser's selected context; it does not revoke credentials held by unrelated sessions or remove an otherwise valid membership. Credential revocation follows the authorization policy below.

### Authorization freshness

Membership removal, role changes, agent revocation, and organization suspension must affect access within a small, explicitly bounded interval. Token lifetime and authorization freshness are separate controls.

**Decision:** Validate current organization/principal authorization per request against authoritative state. This builds on the existing principal lookup. Already-admitted requests follow the operation's concurrency rules; new requests must observe committed revocation. Sensitive mutations such as voting must define their authorization point in the transaction design.

If measurements justify caching, introduce a bounded freshness window and invalidate affected entries on changes. Cache failure must not authorize from indefinitely stale data. A stricter path for sensitive mutations remains possible without changing the tenancy model.

Token-only authorization until expiry is not the initial policy. Token lifetime does not extend revoked organization authority. A cache and its acceptable stale-access window would require a later explicit decision supported by measurements.

## 6. Organization creation and lifecycle

### Creation and ownership

There is **no default organization**, reserved default UUID, or first-login access to a shared customer workspace. A SaaS user can create and initially own an organization through onboarding. Automatic versus explicit creation remains a product choice; neither may expose another customer's organization.

Self-hosted setup creates a real organization and explicitly assigns initial ownership under the operator's bootstrap policy. Tests create their own organization fixtures.

Organization identifiers and names/slugs remain reserved after deletion for now. They are not reassigned to another customer. Display-name and naming-normalization details follow in the low-level design.

### Suspension and grace periods

Suspension pauses background execution and prevents operations disallowed by the lifecycle policy. Accepted tasks remain durably associated with the organization for possible resumption. Workers must not repeatedly execute or rapidly retry paused work.

Payment failure can have a grace period before suspension. Suspected compromise, abuse, or an operator/customer request may require immediate restriction. Suspension is a reasoned lifecycle policy rather than a synonym for unpaid billing.

Recovery, billing remediation, and organization management require explicitly limited access while suspended. In-flight external requests cannot be recalled; execution must prevent new dispatch once suspension is observed and define reconciliation of outstanding work.

On resumption, expired workflows and stale actions are evaluated against current workflow rules. Pausing does not implicitly extend every workflow deadline.

### Removal, retention, and deletion

Member removal revokes authority while preserving attribution for approvals and audit records accumulated after launch. This requirement concerns history created after launch.

Deletion blocks access and execution, applies retention policy, then purges eligible data. Queue history, caches, credentials, backups, and restore procedures must respect that policy. Durations and cleanup implementation are deferred.

Deleting an organization must preserve platform login accounts still associated with another organization; organization-owned enterprise accounts follow the deleted organization's lifecycle. Permanent name/ID reservation requires retained identifying metadata after customer payloads are purged.

## 7. Background work, quotas, and auditing

Every tenant job carries durable organization context and a stable task/event identity. The worker establishes its own context, validates stored ownership, and evaluates organization execution policy. It cannot inherit HTTP process-local state.

**Execution direction:** Member departure alone does not cancel committed organization-owned tasks; organization suspension pauses them. Keep the initiating actor for attribution. Operations requiring the actor's continuing personal authority explicitly revalidate it.

Retries, locks, reservations, and deduplication remain bound to the organization and immutable task identity. Preserve `Idempotency-Key` using `taskId` for webhook attempts. Durable recovery must cover committed tasks whose queue publication fails. Dispatch/reconciliation mechanics follow in the worker design.

Quotas and metering use organization ownership independently of measured resource and actor. Quota targets belong to that organization. Admission remains concurrency-safe; adding a filter to a count does not make a separate count-and-create sequence atomic.

Shared workers require bounded per-organization resource use. Queue tiers, worker allocation, and delay objectives are future implementation choices. Multiple queues can share Redis; subscription tier does not determine cell placement.

Tenant audit records carry organization and actual actor. Global account/platform events have a separate scope. Partition counts and strategy are excluded: shared hash partitions cannot be deleted per tenant. Retention and indexing remain aligned with ADRs 003 and 004 until a separate workload-driven decision changes them.

## 8. Security boundaries for future capabilities

### Encryption

Secret storage and cryptographic operations must receive authenticated organization context, authenticate and verify tenant binding when handling ciphertext, and support key versioning. Future organization-specific keys should not require redefining secret ownership across callers.

The data-encryption key (DEK) and key-encryption key (KEK) hierarchy, key-management service (KMS) integration, rotation, caching, and bring-your-own-key (BYOK) behavior belong in a revision of ADR 006. This ADR does not mandate one long-lived DEK per organization.

Encryption protects the fields and threats it covers. A shared runtime authorized to decrypt multiple organizations' data remains trusted. Key revocation does not retract already-decrypted plaintext. No instantaneous BYOK revocation, complete database confidentiality, or compliance guarantee is asserted.

### External connectivity

Credentials and destinations are organization-bound. Requests follow deployment-approved egress policy, including server-side request forgery (SSRF) protection and controlled exceptions for self-hosted private-network integrations.

A shared outbound IP does not identify a customer. Receivers need suitable application authentication; signed Approvio webhooks and generic HTTP APIs may use different schemes.

Tunnel agents and dedicated egress IPs are deferred options requiring their own enrollment, authorization, and operational design. Transport topology alone does not establish tenant isolation.

### Platform and support access

A platform administrator can operate the service without automatically receiving permission to browse customer workflows, read secrets, or act as a customer. Support should first use access-controlled operational telemetry: organization/task correlation IDs, queue state, dispatch attempts, timestamps, and sanitized error categories should explain why an approved workflow did not trigger an action.

Reading a workflow's configuration or payload may be necessary to diagnose a condition, destination, or integration-specific failure that telemetry cannot explain. Such customer-data access requires an explicit, scoped, time-limited, revocable grant and records the actual operator. Retrying an action, editing configuration, and exporting data require distinct permissions; a read grant does not authorize them. Secrets are excluded from routine support views.

Logs can themselves contain customer or personal data, so access, redaction, retention, and residency apply to telemetry too. Customer-authorized support and emergency operator access are separate policies. Their tooling is follow-up design; the access boundary is established here.

Grant duration, session lifetime, notifications, and operator indicators follow later. A 24-hour customer grant need not imply a single 24-hour bearer credential.

## 9. Future cells and deployment portability

Cells, geographic routing, dedicated infrastructure, and tenant migration are outside initial delivery. Preserve these properties now:

1. Tenant data and work have explicit, stable ownership.
2. Tenant business relationships do not cross organization boundaries.
3. Requests identify organizations independently of placement; credentials do not depend on cell hostnames.
4. Operations use a contextual persistence/execution boundary so relocating an organization does not change business semantics.
5. Any global identity, directory, or platform metadata is separated from tenant-local authority and data. The placement direction below separates these responsibilities.
6. Suspension/resumption and stable task identities support future operational quiescence and reconciliation.

### Identity and routing direction

Keep these as logical boundaries in the monolith now; separate services are unnecessary at launch. For future cells, the preferred direction is:

| Responsibility | Placement direction |
| --- | --- |
| Organization routing | A minimal directory maps an opaque organization ID to its cell/region. Routing selects a destination; the receiving cell still authenticates and authorizes the request. |
| Platform social accounts | A platform authentication boundary owns provider bindings, account recovery, and login sessions. Its storage may be regionalized; “platform-wide account” does not require one worldwide database. |
| Organization discovery | An authenticated platform account can obtain a limited index of its memberships and destinations. The index is a discovery aid, not authority; current membership is checked in the destination cell. |
| Organization IAM | Organization users, memberships, groups, roles, agent credentials, suspension state, and future enterprise provider configuration live with the organization in its cell. Enterprise authentication must be able to operate within that residency boundary. |

A router can forward requests or direct a browser to the proper endpoint. This does not require separate frontend codebases or a “super cell” holding all customer permissions. A direct organization URL must support enterprise login without first creating a platform social account. Stable organization IDs permit directory-based placement changes; hashing alone would constrain rebalancing and residency exceptions.

Cells should validate authentication evidence and evaluate local authority without a synchronous global IAM lookup on every tenant request. Authentication trust, account/session revocation distribution, and key rotation require a defined protocol before cells ship. A global login or directory outage can still affect new logins, discovery, or placement changes; caches and regional replicas need explicit freshness and failure rules. Cell isolation is incomplete if routine tenant operations depend on one unavailable global service. This direction follows the distinction between a routing layer and independently operating cells in [AWS cell architecture guidance](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/what-is-a-cell-based-architecture.html).

### Residency applies to identity and operations too

Residency and transfer requirements must be assessed for identity profiles, provider identifiers, memberships, sessions, audit records, telemetry, backups, and support access as well as workflow data. Even a small directory can disclose personal data when it maps a person to organizations. Requirements depend on jurisdiction, contracts, data categories, recipients, and processing/access locations; this ADR does not assert that all IAM must be global or that every regulation requires local IAM.

The architecture must therefore permit regional authentication and organization-local enterprise IAM, with minimal cross-region metadata and direct regional entry points where necessary. Whether platform social login can serve a particular residency offering is a deployment/product decision. EDPB guidance explains that international-transfer analysis includes certain remote support access and onward transfers, not just database storage location. [EDPB transfer guidance](https://www.edpb.europa.eu/system/files/2021-06/edpb_recommendations_202001vo.2.0_supplementarymeasurestransferstools_en.pdf)

These avoid known structural obstacles. They do not eliminate future routing, authentication distribution, data transfer, fencing, recovery, or operations work. PostgreSQL replication may be one mechanism; it is not a zero-downtime guarantee. Planned maintenance during initial tenant moves remains an available trade-off.

Self-hosted installations need no edge service, Kubernetes, hyperscaler-specific storage, or cell control plane for this model. Infrastructure security belongs in deployment guidance with supported provider-neutral capabilities.

## 10. Follow-up design

The core decisions above establish the HLD. The following details belong in subsequent product, low-level, or deployment design:

| Topic | Required follow-up |
| --- | --- |
| Identity and sessions | Platform versus enterprise account schemas, recovery, invitation matching, future SSO transitions, and session transport. No implicit email-based linking. |
| Storage and authorization | Tenant-matching constraints, RLS policies and roles, transaction propagation/retries, and authoritative per-request checks. |
| Browser switching | One active organization per browser session, server mismatch handling, and cross-tab UX; no logout of unrelated devices. |
| Onboarding and ownership | Automatic versus explicit creation, self-hosted bootstrap, owner/admin powers, and recovery with multiple owners. |
| Lifecycle and work | Grace periods, paused-work resumption, authorization points, in-flight reconciliation, retention, and deletion. |
| Future cells | Placement/routing, authentication trust and revocation distribution, regional identity requirements, capacity triggers, and migration operations. |

Include isolation checks for cross-org references, revocation, stale browser contexts, replayed jobs, and lifecycle transitions. Client/API rollout and migrations belong in the implementation plan.

Align ADR 001 for sessions, ADRs 003/004 for auditing, ADR 006 for tenant-aware encryption, ADR 008 for eventual linking/organization SSO, and ADR 009 for organization attribution and lifecycle-aware entitlements.

The optional [technical decision notes](010-tenancy-decision-notes.md) expand the trade-offs; the decisions and required boundaries are contained in this ADR.
