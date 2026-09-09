# Database migrations

Liquibase owns the database schema. Prisma models are introspected from an applied schema; do not edit
`prisma/schema.prisma` by hand.

## ADR 010

Tenant-owned tables expose both their global `id` primary key and a unique `(organization_id, id)` key. The latter is
required by PostgreSQL for composite foreign keys such as `(organization_id, group_id) -> groups(organization_id, id)`.
It prevents a child row from pointing to a valid ID owned by another organization. The supporting unique index is an
intentional storage cost for database-enforced tenant matching.

Database migrations define required columns and relationships, not application defaults. Domain factories and
application write paths must supply timestamps, versions, state, counters and structured empty values explicitly.

Ciphertext columns use the `enc_` prefix. Their corresponding domain/API properties retain their plaintext names;
encryption and decryption occur only at the persistence boundary.

Liquibase creates non-login runtime capability roles and their grants. The migration credential is separate from
application credentials. Runtime roles are neither table owners nor members of the migration role and have no
`SUPERUSER`, `BYPASSRLS`, DDL, `TRUNCATE`, or Liquibase metadata access.

## Database logins and capability roles

Provision the three login roles outside this repository, using the deployment's secret manager or database-native
identity mechanism. Their credentials must never be Liquibase properties or changelog content. The required role
names and minimum attributes are documented in `deploy/database-principals.md`. After they exist, Liquibase grants
their non-secret runtime capabilities. The disposable Compose databases use `yarn db:provision-local-logins` or
`yarn db:provision-local-test-logins` before migration.

- `approvio_tenant`: organization-scoped API transactions; may assume `approvio_tenant_runtime` only.
- `approvio_platform`: platform-global identity, session, discovery and organization-provisioning operations.
- `approvio_worker`: task dispatch, audit, metering and scheduler operations.

The `approvio_*_runtime` roles are non-login capability roles. They receive the table grants and RLS policies; the
three logins receive only the capabilities needed by their process. These identifiers are a database security ABI and
are referenced by Liquibase policies, capability clients and the acceptance test. Keep their membership map
synchronized. The scheduler client uses the worker login; the tenant login is intentionally not a member of
`approvio_scheduler_runtime`.

## Tenant isolation acceptance test

`db-migrations/tests/tenant-isolation.sql` is a PostgreSQL acceptance test, not a Liquibase changeset. It runs as
part of `yarn test` against the disposable integration-test database before Jest clones it. It validates runtime role
attributes and memberships, forced RLS on every public table with a non-null `organization_id`, missing-context
read/write denial, cross-organization write rejection, composite tenant foreign keys, and preservation of vote/audit
attribution after membership removal. Its fixture transaction rolls back so cloned Jest databases remain clean.

Run it against the disposable development database with:

```shell
yarn test:tenant-isolation
```

The command prepares the disposable integration-test database, then invokes `psql` in its Compose database container.
It remains separately runnable because it asserts PostgreSQL catalog state, `SET ROLE`, RLS visibility and SQLSTATE
failures that application integration tests cannot exercise through their normal bootstrap-admin connection. New
tenant tables require a non-null `organization_id`; the metadata assertion discovers them automatically and fails
until their migration enables and forces RLS.
