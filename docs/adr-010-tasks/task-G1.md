# G1: Integrated cutover rehearsal and release gate

Wave: [G](wave-G.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

Cross-repository integration/version manifest, final wiring fixes and verification report.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Integrate all prior waves and pin compatible API/SDK/backend/worker/frontend/CLI artifacts locally. Verify the exact SHAs and package versions of any API/SDK PRs already merged, prepare reviewed release PRs for the remaining repositories, and record the required merge/package order; do not merge or publish without separate authorization. Rehearse empty install and explicit disposable pre-tenancy cutover: quiesce workers/API, migrate, rotate/invalidate old credentials, select new queue/cache namespace, bootstrap real orgs, restart compatible clients. Test old client/job/schema refusal. Execute real browser/CLI/agent scenarios across two orgs, including invitation, switch, step-up vote, suspension/resume and outbox recovery. Measure authority lookup/transaction latency and fairness under small-pool load; record results without claiming unsupported capacity.

## Acceptance

Both backend/worker build, backend lint diff reviewed, all affected isolated/integration suites plus F acceptance pass; API/SDK/frontend/CLI builds/tests pass using their verified scripts. Confirm no DEFAULT_ORG_ID runtime/fixture fallback, no context-free tenant endpoints, no role bypass, no plaintext tenant secrets in telemetry. Fresh install and rollback/forward-repair rehearsal documented with exact package/schema versions. All ADR coverage rows have evidence or explicitly deferred scope justified by ADR.

## Boundaries

Do not publish, deploy to shared/production environments, reset user data or merge main as part of this gate unless separately authorized. Final handoff lists commands/results and any real blocker; no claim of release-ready with failed mandatory isolation tests.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
