# E5: Durable tenant workers and external dispatch

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

Queue/task/webhook services, queue adapter, worker processors, outbound clients/SSRF integration, Redis dispatch admission and worker tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Persist event intents transactionally, publish after commit on a best-effort basis for low latency, and retain the outbox relay for recovery; consume E4 recalculation port through B2 interface. Envelopes require schemaVersion/org/event/resource and task ID; verify stored ownership before processing. Implement per-org bounded round-robin relay, atomic concurrency leases, durable duplicate suppression, claim fencing and unknown outcomes. Park suspended tasks durably; lifecycle resume triggers bounded reconciliation and expiry before dispatch. Separate DB admission/attempt record, external call, DB completion; recheck current organization status before a new send and allow restricted in-flight reconciliation. Preserve taskId Idempotency-Key and transient-only retries. Enforce SSRF policy/redirect validation and redacted errors for all tenant destinations. Member departure does not cancel committed org-owned work.

## Acceptance

Tests cover forged/replayed A payload with B task, publication failure and relay crash, duplicate task events, expired lease/stale completion, worker restart, suspend between claim/send and in-flight completion, resume past deadline, DB OCC retries, Redis loss, permanent vs transient/ambiguous external failures. Saturate A and prove B progresses with configured cap; paused jobs must not spin. Email/Slack ambiguous delivery parks for reconciliation.

## Boundaries

No workflow business implementation (E4), lifecycle APIs (E2) or metered reservation implementation (E6). Consume their frozen ports using typed fakes in isolated tests.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
