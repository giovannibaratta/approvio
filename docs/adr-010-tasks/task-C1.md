# C1: Tenant transaction boundary and isolation fixtures

Wave: [C](wave-C.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/database/database-client.ts, transaction-context.ts, transaction-manager.ts; dedicated capability clients; app/test database/context/organization fixture helpers and database-boundary tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement B2 ports using B1 schema and grants. Remove tenant root-client fallback; parameterize transaction-local org setting before reads on every retry; reject cross-org nesting and stronger nested isolation. Keep platform identity/discovery/directory clients narrow; tenant callers cannot request arbitrary platform access. Add bounded whole-transaction retry on confirmed OCC/serialization/deadlock, preserving Left rollback and typed exhaustion; do not retry ambiguous commit outcomes or arbitrary P2028. Build two-org fixtures, one shared account with independent local users, removed users, owners, agents and restricted runtime connections; cleanup uses separate isolated test admin credentials.

## Acceptance

Small-pool concurrent A/B transactions do not leak context after commit/rollback/retry. Missing context fails before tenant queries. Nested same-org calls share transaction; nested different org fails. Inject OCC/serialization and business Left; prove retry/rollback and no external callback replay. Check platform ports cannot query tenant tables; test provisioning and discovery projection capability paths.

## Boundaries

No resource repositories (D), crypto adapter (C2) or service orchestration (E). Intermediate untouched callers may remain incompatible; boundary tests use frozen ports.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
