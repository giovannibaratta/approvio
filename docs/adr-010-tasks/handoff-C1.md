# C1 handoff

Result: C1 is complete on `adr-010-backend-integration`. Tenant database access now requires an explicit organization transaction, establishes the restricted database role and parameterized transaction-local context on every attempt, and fails closed outside that boundary. Platform capabilities use separate clients with fixed database roles.

## Tenant transaction boundary

- `DatabaseClient.cx` no longer falls back to the root Prisma client. It throws before a repository query when no tenant transaction is active.
- The ambient transaction context stores the organization ID, transaction client and isolation level. Same-organization nesting reuses the transaction; a different organization or stronger nested isolation is rejected.
- Each outer attempt executes `SET LOCAL ROLE approvio_tenant_runtime`, then parameterized `set_config('approvio.organization_id', organizationId, true)` before running application code.
- Whole transactions retry only confirmed Prisma `P2034` serialization/deadlock conflicts and explicit OCC conflicts surfaced as `concurrency_error`. Business `Left` values roll back once and are not replayed. Arbitrary `P2028` errors are not retried; commit-related `P2028` maps separately from storage failure.
- Retry exhaustion, invalid context, organization mismatch, isolation conflict and storage/commit outcomes map to the frozen `TransactionError` union. Default transaction retry timing is three total attempts, 25 ms base and 250 ms cap with full jitter.
- The integration fixture uses a two-connection tenant pool and contains two organizations, one shared account with distinct local users, a removed user and an agent per organization. Prepared databases are dropped through a separately validated test-admin path.

## Capability clients

- Added fixed-role identity, session, discovery, provisioning and scheduler database clients. Their underlying Prisma clients are private; every callback begins only after its hard-coded role is active.
- `PLATFORM_DATABASE_URL` is required configuration and is stored in `databaseConfig.platformConnectionUrl`; the current deployment model provisions the platform capability connection for every process.
- Provisioning uses its generated organization ID as transaction-local context and its insert-only grants. Callers must use parameterized insert operations where Prisma's implicit `RETURNING` would require intentionally absent read privileges.
- Capability tests prove identity/session/scheduler roles cannot query tenant users. Discovery can read only active membership keys and proves atomic organization/owner provisioning plus account-scoped discovery reads.

## Discovery design

Organization discovery reads active local membership keys through the restricted discovery capability and joins the organization directory for display data. There is no duplicated account-to-organization projection or privileged synchronization function. The B1 restricted SQL suite verifies that ordinary tenant access remains isolated while discovery has only the columns needed for this account-scoped lookup.

## Verification

Fresh-cluster verification on 2026-09-23:

- Started a disposable PostgreSQL 17 cluster and provisioned only the documented tenant, platform,
  and worker login roles. The full `root-changelog.yaml` applied all 39 changesets.
- `db-migrations/tests/tenant-isolation.sql`: passed against the fresh schema and rolled back its
  fixtures. It verifies forced RLS, capability attributes/memberships, tenant-local visibility and
  writes, composite FK enforcement, and retained attribution.
- `app/external/test/database/transaction-manager.integration.test.ts`: 1 suite, 11 tests passed on
  databases cloned from that cluster, including tenant context, retry/rollback, nesting and platform
  capability boundaries.
- `app/external/test/database`: 24 suites, 55 tests passed on fresh-cluster clones.
- `yarn tsc --noEmit` and scoped ESLint over C1 source, fixtures and transaction tests: passed.
- The shared test helper now derives isolated connection URLs from `TENANT_DATABASE_URL`, preserving
  the configured host/port so fresh-cluster verification does not assume the default test port.

## Integration boundary

Concrete resource repositories and services were migrated in D/E. Capability clients are registered in the integrated persistence module; the clean-cluster checks above verify their restricted behavior. No compatibility fallback was added.

No commit, stash, push or package publication was performed.
