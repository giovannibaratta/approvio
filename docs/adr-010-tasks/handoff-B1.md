# B1 handoff

Result: B1 is complete on `adr-010-backend-integration`. The database is a clean-slate, organization-qualified schema with restricted runtime capabilities, composite tenant integrity and forced row-level security. This is an intermediate breaking branch and the untouched application is not expected to build until the later backend waves are integrated.

## Schema and migration shape

- Replaced the legacy application changelog with one conventional Liquibase YAML file per table or database-security change. The existing Liquibase metadata-primary-key changeset remains the first include.
- Used `createTable`, `addForeignKeyConstraint`, `addUniqueConstraint` and `createIndex` YAML changes for ordinary schema objects. Raw PostgreSQL SQL is isolated to CHECK expressions, partial/BRIN indexes, trigger functions, role/grant management and RLS policies.
- Added platform accounts and provider connections separately from organization-local users; organization invitations, direct active-membership discovery, browser sessions and separate platform/agent refresh tokens are explicit tables.
- Added `organization_id` to every tenant-owned relation, tenant-leading indexes, composite tenant-matching foreign keys and `ON DELETE RESTRICT` where attribution or durable history must survive principal removal.
- Added durable outbox, action tasks, fenced dispatch attempts, step-up receipts, quota admission, usage reconciliation, tenant audit and platform security event storage. The separate `tenant_event_receipts` table required by the frozen D3 replay contract is not present; the prior B1 claim of consumer receipts was inaccurate and this schema gap remains open in [PENDING.md](PENDING.md).
- Updated the migration timestamp and regenerated `prisma/schema.prisma` and the Prisma client from the migrated database.

## Isolation and runtime capabilities

- Enabled and forced RLS on the organization directory and all 24 tenant-owned tables. Tenant policies fail closed when `approvio.organization_id` is absent and apply the same predicate to reads and writes.
- Added non-login capability roles for tenant data, identity, sessions, discovery, provisioning, scheduling, workers, auditing and metering. Runtime-role collisions fail the clean-slate migration.
- External deployment provisioning creates the three secret-bearing login roles. Liquibase grants their disjoint capabilities: tenant application, platform identity/session, and worker/audit/metering. Runtime roles cannot own relations, access Liquibase metadata, create schema objects, truncate tables or bypass RLS.
- Discovery queries active local memberships through its restricted capability; no synchronized account-to-organization projection exists.

## Contract correction

The implemented workflow-template identity is `(organization_id, name, version)` with immutable template `id`; there is no workflow template family table or `family_id`. This incorporates the reviewed API decision that an organization-qualified template name is the reusable identity. Remaining `family_id` columns belong only to refresh-token rotation families. Provider issuer is not globally unique; identity uniqueness is enforced by the provider-connection/issuer/subject identity key.

This deliberately corrects A1's proposed template-family default and must be carried into B2 and the Wave B barrier instead of reintroducing a second template identity.

## Verification

- `yarn db:update-schema`: passed from an empty disposable development database; all 35 changesets applied, Prisma introspected 35 models and client generation passed.
- Fresh-cluster verification on 2026-09-23: after provisioning only the three documented external login roles, Liquibase applied all 39 changesets from `root-changelog.yaml`; `organizations.plan_tier` is `text NOT NULL`, its security registry entry is active, and tenant/discovery/provisioning/scheduler policies are present.
- `db-migrations/tests/tenant-isolation.sql` passed on that fresh cluster after the required `plan_tier` fixture update; it checked runtime-role attributes, forced RLS, tenant-scoped visibility/writes, composite FK enforcement and retained attribution, then rolled all fixtures back.
- `yarn liquibase:update:dev`: passed as a no-op with 35 previously-run changesets.
- `db-migrations/tests/tenant-isolation.sql`: passed against PostgreSQL through the restricted role. It proves forced RLS coverage, foreign-row invisibility, cross-tenant write rejection, composite-FK rejection, valid same-tenant links, safe role attributes/grants, and preservation of votes/audit attribution after user removal.
- The suite was rerun after the C1 projection correction and additionally proves function ownership/grants, missing-context rejection, valid projection creation and rejection for a foreign/non-active membership.
- Direct login checks passed: tenant can read tenant resources but not discovery or migration metadata; platform can read identity storage but not tenant resources or migration metadata; worker can update action tasks but cannot read users or migration metadata.
- `yarn ai:test:setup`: passed and rebuilt the disposable test database with the final changelog.
- `yarn dotenv -e .env.test -- yarn jest app/external/test/database/migration-utils.test.ts --runInBand`: 1 suite and 12 tests passed.
- `yarn prisma validate`, shell syntax checks for the bootstrap/generator scripts and `git diff --check`: passed.

`prisma db pull` initially preserved one stale generated field name from the previous schema. The generated schema was corrected to `stepUpContextVersion`, then introspected and generated again; the final pull preserved the corrected mapping. No handwritten model definition is the source of truth.

## Changed ownership

- `db-migrations/v1/`: clean-slate table/security changesets and root include order.
- `db-migrations/tests/tenant-isolation.sql`: restricted-role acceptance test.
- `db-migrations/integration-tests/convert-tables-to-unlogged.yaml`: complete new table inventory.
- `db-migrations/README.md`: reset/export and role-boundary guidance.
- `prisma/schema.prisma`, `generated/prisma/`: introspected/generated artifacts.
- `app/external/src/database/database-client.ts`: required migration timestamp.
- `deploy/database-principals.md`, `deploy/docker-compose.template.yml`, `deploy/generate-compose.sh`, `scripts/provision-local-db-logins.sh`: external login-principal contract and local/test provisioning helper.

No commit, push, package publication or production data migration was performed.
