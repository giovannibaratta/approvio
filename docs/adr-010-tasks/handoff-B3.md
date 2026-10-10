# B3 handoff

Result: B3 is complete on `/workspace/approvio-api` branch `adr-010-api-contract`. The organization-qualified OpenAPI contract, generated models, validators and validator tests pass their repository gates. No package was published.

## Contract boundary

- Tenant endpoints use `/o/{organizationId}`; `/ping` remains a public system liveness endpoint rather than a tenancy capability.
- Account discovery, browser and CLI organization selection, organization lifecycle, local memberships/invitations, agent authentication and tenant resources have explicit organization-aware schemas.
- Workflow-template identity remains `(organizationId, name, version)` plus immutable revision UUID. There is no template-family schema, endpoint or `familyId` field; refresh-token rotation is the only family concept.
- Tenant payloads use `organizationId`, including entitlement and usage responses. Local membership `id` is distinct from global `accountId`; member display-name search is fuzzy, while a complete email is an exact case-insensitive match only within the selected organization, never a global account search.
- Organization deletion has no request body. It requires the organization- and `delete_organization`-bound step-up access token as the bearer credential for the DELETE request and returns `202` for asynchronous deletion admission.
- Boundary errors include stable `UNKNOWN` forward compatibility. Persistence versions are opaque API validators, not decimal wire fields.
- Resource identifiers remain path parameters and mutation data remains in request bodies. Invitations are independently created, revoked and accepted records, so their immutable IDs remain path parameters while their secret token remains body data. Member routes name the local `{membershipId}` rather than a platform account ID. Conditional mutations use resource `ETag` response headers and required `If-Match` request headers; E2 also serializes membership mutations with organization and membership locks to enforce the last-owner invariant.

## Barrier corrections

The barrier corrected stale A1 planning text that still described template families and a `{stepUpToken}` deletion body. The low-level design, frozen contracts and downstream task descriptions now match the implemented schema and API contract before Wave C begins.

## Verification

- `yarn build`: passed from a clean regeneration.
- `yarn test`: 16 suites and 325 tests passed.
- `yarn eslint .`: passed.
- `yarn lint:api`: passed with zero errors. It retains three pre-existing warnings: missing OpenAPI servers, missing info contact, and unused `RoleOperationRequest`.
- `git diff --check`: passed.
- Review search found no `TODO`, public `orgId`, `OrganizationDelete`, `stepUpToken`, template-family or workflow-template `familyId` references in OpenAPI source, validators or tests. Two internal OpenAPI filenames retain historical `orgId` spelling; their public paths and fields use `organizationId`.

## Artifact and source

- API base SHA: `84908e738619955b825d13b56d03e6a0a05dfc2b`.
- Uncommitted barrier correction diff SHA-256: `d474433f3bebf7864c270aa538de98af9bad9e8b06fb0449a149e863dd4f8da7`.
- Package identity: `@approvio/api@1.0.0` (local artifact only; version has not been bumped or published).
- Local tarball: `/workspace/approvio-api-1.0.0-wave-b.tgz`.
- Tarball SHA-256: `942f98fdcce028b0a84326ae334bb6e197cf5a12f61387811d8319240618bb91`.

No commit, stash, push or registry publication was performed by the barrier correction.
