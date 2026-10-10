# E1: Login, browser switching and request authority

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/services/src/auth/, new platform-account login services, app/main/src/auth/, auth controllers, auth providers/decorators and auth-specific tests. Existing user administration service files belong to E2: B2 must move/freeze the login-facing interface before this wave so E1 does not edit those files.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement platform login without implicit membership, immutable provider/issuer/subject binding, session/refresh transport and tenant credential exchange from D1. Resolve path tenant then current principal/lifecycle; verify signed tenant claim and current browser session version every request. Explicit session CAS switch changes only that session; protect switch/refresh against CSRF and stale responses. Bind step-up and agent challenge/credentials to org and UUID subject; consume step-up receipt inside caller transaction through frozen port. Apply global endpoint allowlist and standardized 401/403/404/409/423 mapping. Preserve provider on refresh and prohibit account merging by email.

## Acceptance

Integration tests cover zero-org login, A/B discovery, stale tab A→B→A, concurrent refresh/switch, two devices, revoked membership/agent/session, wrong-org step-up/DPoP and cookies-vs-bearer behavior. Request after committed removal must fail immediately. Auth storage failure fails closed. No protected controller accepts context-free principal.

## Boundaries

No organization/member administration endpoints (E2) or resource controllers. Consume frozen lifecycle/authority ports; use typed fakes for E2-independent tests.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
