# Wave E: Application and worker behavior

## Start condition

Every task and integration gate in waves A, B, C, D is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [E1: Login, browser switching and request authority](task-E1.md)
- [E2: Organization lifecycle, membership and ownership APIs](task-E2.md)
- [E3: Groups, spaces, templates and hierarchy APIs](task-E3.md)
- [E4: Workflow creation, voting and recalculation rules](task-E4.md)
- [E5: Durable tenant workers and external dispatch](task-E5.md)
- [E6: Organization quotas, usage, audit and capabilities](task-E6.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

All six implementations merged, shared DI/barrels and package pins integrated. Backend AND worker build, relevant service/controller/worker tests pass against real adapters; coordinator checks module startup and no missing port providers. This is the first fully executable application gate.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
