# Wave G: Integrated release gate

## Start condition

Every task and integration gate in waves A, B, C, D, E, F is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [G1: Integrated cutover rehearsal and release gate](task-G1.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

All launch acceptance evidence and cutover rehearsal complete, no mandatory security TODOs. Publish/deploy/merge only with existing or separately supplied authorization.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
