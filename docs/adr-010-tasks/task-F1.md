# F1: Frontend onboarding, organization routes and switching

Wave: [F](wave-F.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

/workspace/approvio-frontend App/router, services/api, auth/store/cache keys, pages and frontend tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Consume C3 SDK and integrated E API. Add zero-org onboarding, own-org chooser/create, qualified routes, member/owner/lifecycle views and explicit account-ID invitation acceptance. Prefix all tenant query/cache keys and links by orgId; prevent pending mutations from being retargeted on switch. Session state/version comes from server; cross-tab notification prompts refresh and never grants authority. Handle 409 by stopping mutation and reloading context, with no automatic replay. Keep HttpOnly token transport; distinguish global profile from local user.

## Acceptance

Two-tab tests cover A→B→A and late response/cache poisoning; switch while edit is pending requires explicit user continuation in original org or cancellation. Test direct org links, zero membership, account-bound invites, suspension/removed membership, auth callback and tenant-bound step-up. Frontend tests/build pass with pinned local SDK/API.

## Boundaries

No backend/SDK changes. Report contract defects for coordinator/upstream corrective task rather than silently inventing endpoints.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
