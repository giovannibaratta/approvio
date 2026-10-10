# E4: Workflow creation, voting and recalculation rules

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

Workflow/vote/recalculation services, workflow/vote controllers and related service/API tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Current scope clarification — 2026-10-05

The user explicitly retains existing optimistic voting behavior. The stricter serialized authorization
proposal below is not an implementation requirement for the current pass. Do not add vote locking or
mid-request authority revalidation. The rejected regression was removed; historical implementation
instructions below do not override this decision. Organization resume work is deferred.

## Implementation

Apply org context to workflow create/list/read/cancel/vote/can-vote/recalculation. Sensitive vote transaction locks org then principal/resource, rechecks live authority, groups, template status, expiry and step-up; persist receipt/vote/audit/outbox atomically. Update optimistic comments/contracts to the explicit authorization point. Use quota port inside workflow admission transaction. Recalculation operates on stored org ownership and emits durable versioned transitions; expiry/resume evaluates current rules without extending deadlines. Pure service methods return DB outcomes; no direct queue publication inside DB retry.

## Acceptance

Race membership/group/role revocation and suspension against vote to prove serialized outcomes; test late step-up replay, foreign votedForGroups, wrong-org template/workflow, withdrawal and expiry. Crash after DB commit/before enqueue leaves durable recalculation work. OCC retry does not consume step-up twice or create duplicate transitions.

## Boundaries

No task generation/dispatch processors (E5). Use frozen outbox/audit/quota ports and D repositories; worker invocations are tested through service ports.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
