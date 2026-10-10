# Wave A: Contract freeze

Gate complete: see [A1 handoff](handoff-A1.md). Wave B consumes [contracts.md](contracts.md) and [inventory.md](inventory.md).

## Start condition

Read the ADR, current implementation and proposed low-level design. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [A1: Freeze interfaces, inventories and decisions](task-A1.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

contracts.md is complete; every required schema/port/route/state transition is concrete. Review the parallel file ownership and requirement mapping. No code build required.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
