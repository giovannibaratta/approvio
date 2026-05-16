# ADR 003: Approvio Auditing System Architecture

## Context and Problem Statement

The Approvio platform requires a comprehensive auditing system to track modifications to core entities. The system must provide a reliable historical ledger of who changed what and when, ensuring data integrity without significantly degrading the performance of the primary transactional database or imposing massive maintenance burdens on the development team.

We need to decide on a pragmatic initial architecture that meets our immediate needs (a List API) while providing a clear evolutionary path toward a fully compliant, enterprise-grade auditing infrastructure.

## Considered Options

### Schema Design

1. **Multi-Table Strongly Typed:** One audit table per business entity. Provides excellent type safety and query performance but introduces massive schema migration overhead.
2. **Single-Table Polymorphic (Hybrid):** A single centralized table containing structured metadata columns for indexing and a schemaless JSON/JSONB column for the payload/diff. Provides high flexibility.

### Execution Model

1. **Asynchronous (Best-Effort):** Emitting an audit event to a queue out-of-band. Vulnerable to the Dual-Write Problem where primary transactions succeed but audit events are lost.
2. **Synchronous (Transactional):** Writing the audit log in the exact same database transaction as the primary business mutation. Guarantees consistency.
3. **Transactional Outbox:** Writing to a local outbox table atomically, then processing asynchronously. Ideal for external data propagation but adds complexity.

### Capture Mechanism

1. **Database Triggers:** Catches all changes at the DB level, but lacks application context (e.g., "who" made the change).
2. **Application-Level Interception:** Computing logical diffs at the domain/service level. Retains full context but misses raw DB queries.

## Decision

We will implement a **Single-Table Hybrid** approach with **Synchronous Transactional** execution and **Application-Level Capture**.

Specifically, we have decided to implement the following:

1. **Storage Location:** We will store the audit logs in the same primary PostgreSQL database.
2. **Schema Architecture:** We will use a single hybrid table. It will contain strongly-typed metadata columns and a schemaless JSON field (`payload`) for the data diff.
3. **Payload Versioning & Validation:** Even though the payload field is schemaless JSON, we will define JSON schemas as code (including version definitions) for every possible audit type. These schemas will be used to strictly validate the payload both during writing and reading.
4. **Audit Scope:** The audit type will capture CUD (Create, Update, Delete) operations for `USER`, `GROUPS`, `SPACES`, `TEMPLATES`. We will also include `VOTES` as a permanent storage mechanism in case a workflow is deleted.
5. **Data Immutability (Application Level):** We will add a Prisma Client Extension that explicitly prevents `update` and `delete` operations on the new audit table. Only `create` (append) operations will be allowed.
6. **Data Capture (Logical Diff):** The audit payload will not be a full dump of the entity. Instead, it will be a logical diff computed at the domain/service level using a specialized library (e.g., `json-diff-ts`).
7. **Execution (Transaction Scope):** The audit write must be atomically committed with the primary business mutation. We will implement a mechanism to transparently expose the transaction scope for the repository layer. This allows the service layer to start a transaction and commit it without knowing the low-level details of Prisma.
8. **DB Triggers:** We will **not** use DB triggers. All logic resides in the application.
9. **Cryptographic Hash:** We will **not** implement a cryptographic hash chain for tamper evidence at this stage.
10. **Immediate Usage:** For the immediate term, we will only build a List endpoint with basic filtering to expose these audit logs.

## Future Extensions

- **Transactional Outbox & Event Processing:** If we eventually require heavy processing of audit logs, we will adopt the Transactional Outbox approach + event processing.
- **OLAP Offloading:** Alternatively, audits will be moved to a different dedicated database via infrastructure-level replication or application-level syncing.
- **Cryptographic Tamper-Evidence:** Integrating sequential hashing of payloads to mathematically guarantee that logs have not been altered.
- **Database-Level Immutability:** Revoking DB user `UPDATE`/`DELETE` permissions on the audit table via DB configuration.
