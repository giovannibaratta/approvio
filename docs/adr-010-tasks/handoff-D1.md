# D1 handoff (acceptance coverage updated; coordinator integration pending)

This file records the current D1 evidence. Its repository acceptance scenarios now have real-database
coverage, but D1 is not considered barrier-ready until the Wave D coordinator gate and fresh-cluster
C1 verification are complete. Wave D must not be treated as ready for Wave E.

## Implemented in this checkpoint

- Added the insert-only provisioning adapter that creates an organization and its owner in one provisioning-capability transaction.
- Added tenant-scoped invitation storage with row locking for acceptance/revocation transitions.
- Added durable tenant step-up receipt issue/conditional consumption.
- Converted the agent adapter to explicit `TenantContext` signatures and organization-qualified selectors.
- Converted agent challenge persistence to `(organization_id, nonce)` lookup and composite update guards.
- Replaced the legacy refresh-token adapter with separate platform account/session and tenant-agent adapters.
- Converted PKCE persistence to the session capability and platform context-bound encryption.
- Replaced the remaining legacy local-user adapter with a tenant-qualified membership-shaped implementation and removed the obsolete organization-admin and email-identity adapters from the persistence surface. Refresh DI now binds separate account and agent refresh-token ports.

## Files changed

- `app/external/src/database/organization-provisioner.repository.ts`
- `app/external/src/database/invitation.repository.ts`
- `app/external/src/database/step-up-receipt.repository.ts`
- `app/external/src/database/agent.repository.ts`
- `app/external/src/database/agent-challenge.repository.ts`
- `app/external/src/database/refresh-token.repository.ts`
- `app/external/src/database/pkce-session.repository.ts`
- `app/external/src/database/index.ts`
- `app/external/test/database/pkce-session.repository.integration.test.ts`
- `app/external/test/database/account-discovery.repository.integration.test.ts`
- `app/test/database.ts`
- `app/test/mock-data.ts`

## Verification

- `yarn eslint app/external/src/database/organization-provisioner.repository.ts app/external/src/database/invitation.repository.ts app/external/src/database/step-up-receipt.repository.ts app/external/src/database/index.ts`: passed.
- `yarn eslint app/external/src/database/agent.repository.ts`: passed.
- Scoped ESLint for the changed D1 adapters and PKCE integration test: passed.
- `yarn tsc --pretty false --noEmit -p app/external/tsconfig.json`, filtered for the changed D1 adapters: no diagnostics for those adapters.
- `yarn test:jest app/external/test/database/pkce-session.repository.integration.test.ts`: passed after migrating the test to direct platform-session and context-bound-encryption setup. The test no longer imports the obsolete shared legacy fixture. The command needs an unrestricted local test database because sandboxed Prisma DDL returns `EPERM` while cloning the per-test database.
- `yarn test:jest app/external/test/database/platform-identity.repository.integration.test.ts`: passed; proves provider/issuer/subject identity lookup and duplicate prevention without email linking.
- `yarn test:jest app/external/test/database/browser-session.repository.integration.test.ts`: passed; proves account-bound session reads and selected-organization CAS rejects stale or foreign-account requests.
- `yarn test:jest app/external/test/database/provider-connection.repository.integration.test.ts`: passed; proves login configuration references resolve to one immutable platform connection rather than a user-controlled issuer or display label.
- `yarn jest --runInBand --runTestsByPath app/external/test/database/account-discovery.repository.integration.test.ts`: passed; proves the restricted discovery capability returns only active local memberships for the supplied account, including an account shared across two orgs.
- `yarn jest --runInBand --runTestsByPath app/external/test/database/vote.repository.integration.test.ts`: passed; proves persisted votes remain queryable with the original voter attribution after the user's local membership is tombstoned.
- `yarn jest --runInBand app/external/test/database`: passed on 2026-09-23 (24 suites, 55 tests), including restricted-role capability boundary, account discovery, invitation transition, membership tombstone/readmission, historical voter retention and concurrent provisioning/session switching.
- The unfiltered external type check remains failing in untouched legacy D1 adapters and later D2–E callers. It is not a D1 completion gate yet.

## Remaining D1 work

- Integrate D1 bindings only at the Wave D coordinator gate; do not add compatibility bindings to the existing application composition root.
