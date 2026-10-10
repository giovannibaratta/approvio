# B2: Domain models and service ports

Wave: [B](wave-B.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/domain/src/, app/domain/test/, service interface files and shared request/context types; no concrete services/adapters/controllers.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement A1 models and frozen ports with organizationId required on tenant entities, local-user/account separation, tenant principal discriminated unions, UUID agent identity, family scope IDs and lifecycle/task state machines. Update RESOURCE_TYPES/system-role/permission-checker for owner/admin/member authority and explicit organization-bound scopes. Pure validation covers org mismatch, invalid transitions, invitation grants, immutable ownership and naming. Define transaction, repository, crypto, quota, audit, outbox, worker admission and auth/session interfaces consumed by D/E. Inventory all existing repository signatures and convert the complete set, including lists/aggregates/bulk/raw operations.

## Acceptance

Domain tests reject authority union across A/B, invalid owner/admin grants and cross-org scope matches; validate removed→readmitted authority reset, tenant payload completeness, task transitions and name/version rules. New ports compile in isolation and export a complete typed contract without any/unsafe casts.

## Boundaries

Do not implement repository or service bodies. Update domain fixtures only; C1 owns shared integration fixtures. Coordinator resolves barrels at the barrier.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
