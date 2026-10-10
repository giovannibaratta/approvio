# C3 handoff

Result: the TypeScript SDK has an explicit local handoff to the reviewed API contract at `approvio-api` commit `7744da744d00e25477680c094ee3d82d88b2dc61` (package version `1.0.0`). No package was published.

## Client boundary

- `ApprovioPlatformClient` owns account lookup, organization discovery/creation, browser session inspection and browser/CLI organization selection. Its routes remain unqualified.
- `ApprovioUserClient` and `ApprovioAgentClient` now require an organization ID and inherit `OrganizationClient`. The ID is readonly and all tenant requests are assembled below `/o/{organizationId}`.
- Constructing another handle cannot mutate an existing handle. Agent token refresh is organization-qualified and the agent authenticator ID must equal the client handle ID.
- Browser switching requires the server ETag and sends `If-Match`. It returns the replacement ETag. Context-changed and suspended responses map to dedicated SDK errors; there is no retry of those failures.
- Conditional role, template, organization and membership mutations take an opaque ETag instead of an OCC body field.

## Local artifact

The SDK manifest uses `@approvio/api: portal:../approvio-api` until the reviewed API package is published. This is the supported local-link handoff; Node consumers launched through this link need `--preserve-symlinks`. Consumers must not treat this as a release artifact; replace it with the published immutable version at the Wave C integration barrier.

## Verification

- `yarn build`: passed.
- `yarn test --runInBand`: 4 suites, 41 tests passed.
- Request-capture tests cover platform versus tenant routing, the immutable A/B handle invariant, browser `If-Match`, tenant resource families and organization-qualified agent/step-up paths.
- `git diff --check`: passed.

No commit, stash, push or package publication was performed.
