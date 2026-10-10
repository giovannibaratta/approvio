# B3: Organization-qualified OpenAPI and validators

Wave: [B](wave-B.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

/workspace/approvio-api OpenAPI, source validators/types, mocks and contract tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement A1 route matrix for every tenant API and explicit global allowlist. Define account/discovery/create-org, session switch/version, organization lifecycle, local membership/invitations, agent auth, organization-scoped workflow templates and standardized context/lifecycle error payloads. Remove implicit-organization/global-admin aliases; specify path-vs-credential validation and 404 anti-enumeration. Retain browser-cookie vs bearer transport contracts and organization-bound step-up. Reconcile every backend `@approvio/api` import against the new contract, including non-controller types such as sorting and authentication-provider models; record each symbol as retained, replaced or removed. Add validators and validator tests for every new or changed request/response model, update mocks/examples, then use repository generation scripts to regenerate API artifacts.

## Acceptance

Contract validates and generated types build; validator tests pass. Tests enforce organization path parameters, missing/malformed IDs, exact error codes and session CAS request/response shape. Full old→new route matrix covers usage, entitlements, audit/me, resource resolve and role endpoints as well as CRUD. The generated package export surface matches the A1 consumer-impact inventory, and a local immutable package artifact plus checksum/version manifest is available to C3 and the E tasks. Backend compilation is deferred until the E integration gate because its controllers intentionally remain incompatible during B/C/D.

## Boundaries

No registry publication is performed by this task. B3 may be proposed and merged as the first standalone GitHub PR once its own contract, validator, generation and build gates pass. A human may then version and publish the package; otherwise produce a local consumable artifact/link manifest for C3 and E consumers. Record the exact API source SHA, package version or local-link target, sibling repo commands and permissions needed for later implementation.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
