# C3: Explicit-organization TypeScript SDK

Wave: [C](wave-C.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

/workspace/approvio-ts-sdk/src/client/, src/auth/, interfaces, SDK tests and dependency manifest.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Consume B3 local API artifact. Separate platform client (login/account/discovery/create) from immutable organization-bound client handles; require organizationId on tenant client creation. Update every CRUD/auth/step-up method, token claims, UUID agent subjects and error mapping. Browser switch is explicit and versioned; never silently resend a failed mutation after context change. CLI/bearer credentials bind organization independently of browser session switching.

## Acceptance

Request-capture tests assert exact org-qualified URLs for every endpoint family and correct platform routes. Two client handles A/B cannot retarget one another. Context mismatch and suspension propagate typed errors; no automatic cross-org replay. Build/typecheck and auth refresh/agent tests pass against B3 contract.

## Boundaries

No frontend/CLI changes yet. Produce local consumable artifact/version handoff for F1/F2; no package publication.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
