# ADR 010: Tenancy Security Boundaries

**Status:** Design note. ADR 010 relies on these controls to keep tenant data isolated. This note records their failure modes and limits.

## Assets and trust boundaries

Tenant resources, secrets, membership, platform identities, browser sessions, audit records, usage data, and delivery credentials need separate handling. A request path, worker, database connection, KMS credential, backup, or support tool becomes a trust boundary when it can read or change one of them.

The runtime has tenant, identity, session, discovery, provisioning, scheduler, worker, audit, metering, and platform-security capabilities. Each capability has a least-privilege database role and a narrow repository API. The role limits what the process can reach; it does not make code running in that process untrusted.

## Threats and controls

| Failure or threat                                     | Required control                                                              | Limit                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A route or repository omits an organization predicate | Tenant transaction context, RLS, and a tenant-only repository API             | RLS only applies after a tenant has been selected.                                 |
| A caller supplies another organization's identifier   | Current membership and organization-state authorization                       | RLS cannot decide whether the selected tenant is authorized.                       |
| A write links rows from different organizations       | Tenant-matching composite foreign keys                                        | Does not validate identifiers embedded in JSON or business rules.                  |
| A repository reaches a platform table by mistake      | Capability-specific client, role grant, and no exported generic Prisma client | The process can still use every table granted to its own role.                     |
| An unsafe query is introduced                         | Restricted role, code review, and isolation tests                             | Parameterization prevents injection; it does not make an authorized role harmless. |
| A worker repeats an external call                     | Persisted dispatch attempt, fencing, and a stable downstream idempotency key  | A crash after the call can still require downstream deduplication.                 |
| Ciphertext is copied to another tenant or resource    | Authenticated encryption context containing tenant, resource, and field       | The current shared keyring is not a key-material boundary.                         |

RLS, authorization, and tenant-matching foreign keys cover different failures. Keep all three.

## Capability and process limits

Use capability-specific clients behind a guarded facade. The facade selects the client. Tenant methods require an organization context; platform methods do not accept one. Repositories receive only the capability client they need, never a generic `PrismaClient`.

The facade must expose only the model delegates required by its capability. It must not expose raw SQL methods, the underlying Prisma client, or a transaction typed as `Prisma.TransactionClient`. Enforce this with a restricted-import lint rule and architecture tests that compile or execute a forbidden access attempt.

Each deployed capability process needs its own `NOINHERIT` login credential with one runtime-role membership. `SET LOCAL ROLE` is a useful accidental-misuse guard when a connection has one membership. It is not a boundary against code execution in a process whose login can assume several capabilities. Until the backend is split into capability processes, a platform deployment that has several capability credentials remains a larger compromise boundary; do not describe it as process isolation.

Tenant context is minted only after membership and organization-state authorization. Request handlers must not turn a body, path, or token claim directly into a database organization context. Worker context is derived from the persisted work item's organization. A database superuser, `BYPASSRLS` role, migration credential, or a compromised process with the same capability can still access its granted data. Deployment separation, secret rotation, network controls, KMS policy, backup controls, and audited support access address those cases.

Check the deployed login roles at startup and in deployment tests: `LOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, and exactly one expected runtime-role membership. The migration principal must be separate and unavailable to runtime processes.

Platform and tenant encryption currently share key material. Authenticated context and API type keep ciphertext use separate, but they do not create a cryptographic boundary. Separate keyrings remain an ADR 006 decision.

## Repository API and tenant context conventions

Tenant-scoped repository methods explicitly accept `context: TenantContext` as their first parameter:

```typescript
persistVoteAndMarkWorkflowRecalculation(context: TenantContext, vote: Vote): TaskEither<PersistVoteError, Vote>
getVotesByWorkflowId(context: TenantContext, workflowId: string): TaskEither<FindVotesError, ReadonlyArray<Vote>>
```

This pattern enforces consistent isolation across the persistence boundary:

- **Symmetry across reads and writes:** Read queries (`findById`, `findMany`) have no entity instance in memory prior to execution. If tenant context were embedded within domain entities (or attached via decorators), reads would still require explicit context parameters. Requiring `context: TenantContext` uniformly preserves interface symmetry.
- **Authority vs. payload separation:** An entity (such as a domain `Vote` or `User`) is a data payload. `TenantContext` represents the verified, authenticated execution boundary. Repositories must never derive transaction or query scope solely from entity payload fields.
- **Compile-time safety over implicit context:** While `DatabaseClient` sets PostgreSQL RLS and transaction metadata in `AsyncLocalStorage`, repository signatures must not rely on implicit ambient context alone. Explicit parameters prevent accidental un-scoped invocation at compile time and keep unit tests deterministic without ambient storage setup.
- **Layer responsibilities:** The service layer verifies that entity payload identifiers match the requestor's tenant context before invoking the repository. The repository binds the database transaction, query filters, and RLS session configuration to `context.organizationId`.


## Transactions, retries, and recovery

Retry a transaction only when the database reports a conflict known to have rolled back, such as a serialization failure or deadlock. Do not replay a timeout or disconnect whose commit outcome is unknown. No external call may run inside a retried transaction.

App-generated IDs and optimistic concurrency detect conflicts, but cannot tell whether an interrupted commit succeeded. The API can recover in three ways:

| Strategy                     | User journey                                                                       | Trade-off                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Return retryable failure     | The client repeats the action after a transient error.                             | Simple, but an ambiguous result may require a read-before-retry.                                             |
| Durable idempotent operation | The client repeats the same operation key; the server returns the recorded result. | Smooth recovery, but requires a tenant-scoped key, request fingerprint, result record, and retention policy. |
| OCC-only reconciliation      | The client reloads state after a conflict and decides whether to retry.            | No new storage, but difficult for users and ambiguous for non-commutative actions.                           |

ADR 010 has not selected one strategy for every mutation. Until it does, APIs return unknown commit outcomes as retryable, and workers use stable operation and idempotency identities. Choose a durable operation record before promising transparent replay for an externally initiated mutation.

## Durable events

The transactional outbox publishes at least once. A tenant event receipt is an inbox record. Add one only when a named internal consumer records the receipt and its local state change in the same transaction. It cannot make an email, webhook, or Slack delivery exactly-once. Those deliveries use durable-work attempts, fencing, and an idempotency key derived from the immutable task identity.

No current internal consumer requires an inbox receipt, so `tenant_event_receipts` is deferred. Add it with the first consumer that needs atomic local deduplication, naming the consumer and its state transition in the migration and repository contract.
