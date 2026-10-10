# Wave F: Clients, acceptance and operations

## Start condition

Every task and integration gate in waves A, B, C, D, E is complete. Tasks below may run in parallel; no task depends on another task in this wave.

## Tasks

- [F1: Frontend onboarding, organization routes and switching](task-F1.md)
- [F2: CLI organization selection and credentials](task-F2.md)
- [F3: Backend isolation and failure acceptance suite](task-F3.md)
- [F4: Deployment, bootstrap, recovery and ADR alignment](task-F4.md)

## Parallel ownership

Each task owns the files listed in its handoff. Shared contracts come from earlier waves. Use typed fakes for peer implementations; do not edit another task's files. Wave coordinator owns integration edits to composition roots, barrels, shared dependency manifests/lockfiles and conflicting fixture call sites after all task outputs are ready. Do not introduce a same-wave sequencing dependency to solve a contract gap.

## Completion gate

Frontend and CLI build/test against completed API/SDK; backend acceptance and isolated deployment/bootstrap checks pass. Coordinator records package versions, remaining fixes and complete requirement matrix. No shared environment cutover yet.

Record integration changes and actual verification results before starting the next wave. A failed gate keeps the wave incomplete.
