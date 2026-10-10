# Wave C: Infrastructure and SDK

## Start condition

Every task and integration gate in waves A, B is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [x] [C1: Tenant transaction boundary and isolation fixtures](task-C1.md)
- [x] [C2: Tenant-authenticated encryption adapter](task-C2.md)
- [C3: Explicit-organization TypeScript SDK](task-C3.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

Context/retry/role isolation tests, encryption substitution tests and SDK contract tests pass. Shared fixtures and local SDK artifact are available. Coordinator integrates capability adapters/wiring without loosening RLS.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
