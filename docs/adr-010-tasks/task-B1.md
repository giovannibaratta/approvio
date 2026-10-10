# B1: Liquibase schema, constraints and runtime roles

Wave: [B](wave-B.md). Dependencies: all tasks in every earlier wave; none in this wave.

Status: complete. Output: [verification and handoff](handoff-B1.md).

## Context and ownership

db-migrations/, generated schema/client artifacts, database migration-version constant, dev/test/deploy database-role initialization only.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement the complete A1 schema matrix, including account/local-user split, family IDs, tenant bindings, history-safe foreign keys, session context versions, invitations, outbox/dispatch state, step-up receipts and usage reconciliation state. Add composite FKs, tenant unique indexes, ownership immutability and ENABLE/FORCE RLS with USING/WITH CHECK. Separate runtime/migration grants; include metadata/identity capability access from A1 without tenant bypass. Add nonempty-data preconditions and clear reset/export guidance; never choose a default owner. Apply to an isolated fresh DB, introspect with prisma:pull/remap, generate client, update REQUIRED_DB_MIGRATION_TIMESTAMP.

## Acceptance

Fresh migration succeeds and rerun is a no-op. SQL tests under restricted role prove read/write RLS, matching FK rejection and valid same-org links. Inspect role membership, BYPASSRLS, ownership, TRUNCATE and DDL grants. Verify removed principal cannot cascade votes/audit away.

## Boundaries

Own all schema migrations for this release so parallel tasks cannot invent conflicting tables. Domain/API code is B2/B3. Never hand-edit Prisma schema definitions.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
