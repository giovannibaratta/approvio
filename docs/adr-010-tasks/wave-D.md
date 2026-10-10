# Wave D: Tenant persistence

## Start condition

Every task and integration gate in waves A, B, C is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [D1: Account, organization and IAM repositories](task-D1.md)
- [D2: Groups, spaces and template repositories](task-D2.md)
- [D3: Workflow, vote, task and outbox repositories](task-D3.md)
- [D4: Quota, usage and audit repositories](task-D4.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

Each repository slice passes same-org success, cross-org denial and concurrency checks with restricted runtime role. Coordinator checks all B2 persistence ports implemented, no tenant root Prisma fallback or missing raw/JSON validation responsibility.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
