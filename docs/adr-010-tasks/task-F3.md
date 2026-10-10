# F3: Backend isolation and failure acceptance suite

Wave: [F](wave-F.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

New dedicated cross-layer integration suites under app/main/test/integration/tenancy and app/worker/test/integration/tenancy; shared fixture corrections limited to tenancy helpers.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Build an ADR coverage matrix and executable acceptance suites against the fully integrated E backend/worker. Use restricted runtime role and two orgs with same resource names plus one shared platform account with unequal permissions. Cover every tenant endpoint and repository access class: lookup/list/count/include/bulk/raw/JSON. Add deterministic concurrency barriers for committed revocation, last owner, voting, quota admission, context switch and worker lifecycle. Exercise outbox/replay/unknown outcomes and encryption substitution. Verify platform operations expose only allowed metadata.

## Acceptance

Targeted suites pass with production-style role separation and pooled connections. Missing/malformed context, forged org jobs and old context-free routes all fail closed. Report actual coverage by requirement and absence of bypass paths; test setup superuser writes are clearly separated from runtime assertions. No timing-only sleep race tests.

## Boundaries

Do not fix implementation in peer-owned files during this task; coordinator assigns corrective work and reruns affected gates. Cross-repository browser/CLI end-to-end validation belongs to G1.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
