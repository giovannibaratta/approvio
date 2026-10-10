# F4: Deployment, bootstrap, recovery and ADR alignment

Wave: [F](wave-F.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

deploy/, scripts for tenancy bootstrap/recovery/cutover, documentation including ADRs 001/003/004/006/008/009 and operational examples; no runtime feature modules.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Provide explicit self-hosted organization bootstrap using E2 audited service port with operator-selected account/org IDs and idempotent invocation. Add scoped owner recovery and reasoned suspend/resume operational commands with no customer-data browse permission. Document runtime/migration role setup, startup checks, queue namespace version, invalid credentials and coordinated package cutover. Write fresh-install/disposable reset rehearsal and rollback instructions; detect populated DB rather than deleting it. Align prior ADRs with context/session lookup, history attribution, tenant-aware encryption, account trust, quota concurrency and suspension. Document deferred physical retention/purge, backup/restore tombstones and support-access tooling.

## Acceptance

Rehearse fresh bootstrap and repeated bootstrap in isolated environment; last-owner recovery records actual operator without exposing secrets/workflow data. Inspect deployment artifact: runtime credentials cannot migrate/bypass RLS. Commands require explicit environment/organization arguments; reset is separately opt-in and not executed on user data. Documentation has no default-org examples or contradictory stateless/soft-race promises.

## Boundaries

No support grant UI, billing automation, cells or automatic data purge. Existing untracked user documents remain untouched.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
