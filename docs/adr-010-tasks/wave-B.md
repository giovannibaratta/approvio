# Wave B: Schema and shared contracts

## Start condition

Every task and integration gate in waves A is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [x] [B1: Liquibase schema, constraints and runtime roles](task-B1.md)
- [x] [B2: Domain models and service ports](task-B2.md)
- [x] [B3: Organization-qualified OpenAPI and validators](task-B3.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

All three outputs match A1. SQL migration/security tests, domain tests and API contract generation pass. Coordinator integrates barrels/schema artifacts and provides local API artifact. This is an intermediate breaking branch, not deployable.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete. See the completed [Wave B integration manifest](integration-manifest-wave-B.md).
