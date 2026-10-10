# Tenant security automation: feasibility and design options

Status: temporary design note for external review. This file is intentionally under `docs/internal` and is not part of the ADR deliverables.

## Context

The database-security migration currently keeps an explicit list of tenant tables. For each listed table it enables and forces PostgreSQL row-level security, creates a tenant policy, and grants selected capabilities to runtime roles.

The concern is maintenance: every new table appears to require an edit to the central security migration.

This repository is still pre-production. The migrations can therefore be reordered and consolidated before the first production deployment. That changes the feasibility assessment: the security automation can be installed before future table migrations, rather than being introduced after the schema already exists.

The desired security default is:

- an untagged table receives no runtime-role grants;
- there are no broad default grants for future tables;
- a table becomes usable by application runtime roles only after explicit security classification;
- tenant tables receive RLS and the correct policy before runtime use;
- the final acceptance test verifies the catalog state.

The table owner will still have PostgreSQL owner privileges. The migration/application runtime roles must remain separate from the owner and must not receive implicit access.

## Important PostgreSQL behavior

`ALTER DEFAULT PRIVILEGES` can configure grants for future objects, but it does not configure RLS or policies. It also applies according to the role that creates the object, not merely the role memberships inherited by that creator.

Therefore, default privileges cannot express:

- tenant versus platform tables;
- different capability roles per table;
- different CRUD operations per capability;
- special policies such as organization-directory or discovery access.

They are useful only for broad future grants, which conflicts with the least-privilege requirement here. The safer default is to revoke public access and grant nothing to runtime roles until a table is classified.

PostgreSQL event triggers run inside the DDL transaction. A failing trigger rolls back the DDL. A `ddl_command_end` trigger can inspect the catalogs after the DDL statement has taken effect but before commit.

## Candidate designs

### A. Explicit central manifest

Keep the current array of table names in the database-security migration.

Pros:

- simple and visible;
- easy to review;
- no additional metadata model.

Cons:

- central list must be updated for every table;
- policy and grant configuration remains duplicated elsewhere;
- omission is only detected by the acceptance test unless another validator is added.

This is safe only if runtime grants remain explicit and the acceptance test remains mandatory.

### B. Catalog discovery by `organization_id`

Discover every table with a non-null `organization_id` and automatically apply the generic tenant policy.

This is insufficient as the primary mechanism. The presence of a column does not identify the required policy or capability grants. It also cannot handle tables whose organization relationship is special or derived.

It can remain a useful verification rule:

```text
every public table with NOT NULL organization_id
  must be registered
  must have ENABLE and FORCE RLS
```

### C. Table comments as tags

Use PostgreSQL comments as lightweight metadata:

```sql
COMMENT ON TABLE workflows IS 'approvio:security-class=tenant';
```

The event trigger or acceptance test can read the comment from `pg_description`.

This is easy to inspect, but comments are unstructured and are applied after `CREATE TABLE`. A `ddl_command_start` trigger cannot require a comment that does not exist yet. A `ddl_command_end` trigger can observe the comment only when the separate `COMMENT` statement runs; it cannot guarantee that an earlier untagged table creation will never be used.

Comments are suitable as documentation or a validation tag, but weak as the only enforcement mechanism.

### D. Structured security registry plus event trigger

Create a protected registry containing the security classification before the table is created:

```sql
CREATE TABLE approvio_security_table_registry (
  table_name text PRIMARY KEY,
  security_class text NOT NULL,
  capability_profile text NOT NULL
);
```

A table migration would first insert the intended security metadata:

```yaml
- insert:
    tableName: approvio_security_table_registry
    columns:
      - column:
          name: table_name
          value: workflows
      - column:
          name: security_class
          value: tenant
      - column:
          name: capability_profile
          value: tenant_workflow

- createTable:
    tableName: workflows
```

It would then execute `CREATE TABLE workflows (...)`.

The `ddl_command_end` event trigger rejects a public table creation unless a registry entry exists. It then:

1. read the registry entry;
2. verify the table shape matches the classification;
3. enable and force RLS when required;
4. create the policy for the security class;
5. apply the grants represented by the capability profile;
6. mark the registry entry active.

The registry insert and table creation occur in the same Liquibase changeset transaction. If the table creation or security setup fails, both the table and registry row roll back.

The registry must not accept arbitrary role names or arbitrary SQL from application code. Table migrations insert only a `security_class` and `capability_profile`; both select from a database-owned allowlist, for example:

```text
tenant
tenant_audit
organization_directory
platform_global
platform_security_event
```

This is the strongest event-driven design considered here. It removes the central table-name array while preserving explicit security intent.

### E. Explicit helper without event triggers

Use the same registry and classification profiles, but require each table migration to configure the table after creating it:

```sql
SELECT approvio_configure_table(
  'workflows'::regclass,
  'tenant',
  'tenant_workflow'
);
```

The helper applies RLS, policies, grants, and registry state. The acceptance test verifies that no table is missing configuration.

This is simpler than event triggers and easier to debug, but a migration can temporarily create an unconfigured table before the helper call. That is acceptable only if Liquibase transactions and the separate runtime connection prevent application use during migration.

## Event-trigger feasibility assessment

The event-driven design is feasible, but it is not a small SQL convenience. It introduces:

- a security registry;
- one or more `SECURITY DEFINER` functions;
- event-trigger functions;
- a controlled classification/profile vocabulary;
- owner and `search_path` hardening;
- recursion and internal-DDL handling;
- explicit handling for `CREATE TABLE`, `CREATE TABLE AS`, partition creation, `ALTER TABLE`, `DROP TABLE`, and renames;
- tests for failed unregistered DDL and successful registered DDL;
- operational documentation for debugging migration failures.

The event trigger must not blindly apply the generic tenant policy to every table. Its job should be to enforce registration and dispatch a known security profile.

The trigger also needs to distinguish internal DDL generated while applying a profile from user migration DDL. Otherwise its own `ALTER TABLE`, `CREATE POLICY`, and grant statements may recursively trigger the same enforcement logic.

Because this is PostgreSQL-specific, it weakens the portability of the migration layer. That may be acceptable for ADR-010 because RLS and capability roles are already PostgreSQL-specific, but it should be an explicit decision.

## Permission strategy

Recommended permission rules:

1. Revoke table privileges from `PUBLIC`.
2. Do not configure broad default grants for runtime roles.
3. Keep runtime roles separate from the migration/table-owner role.
4. Apply grants from an allowlisted capability profile during table registration.
5. Verify grants in the acceptance test, not only RLS flags.

Example profile:

```text
tenant_workflow:
  approvio_tenant_runtime: SELECT, INSERT, UPDATE, DELETE
  approvio_worker_runtime: SELECT, UPDATE

tenant_audit:
  approvio_tenant_runtime: INSERT
  approvio_audit_runtime: INSERT
```

The profile should be defined by the database-security migration. The table migration chooses a profile; it must not invent a new role combination through arbitrary SQL.

## Recommended direction for the clean-slate migration

The preferred design to evaluate first is D:

```text
security bootstrap
  -> roles, registry, profiles, event triggers

table migration
  -> register table and security profile
  -> create table

event trigger
  -> require registration
  -> configure RLS/policy/grants

acceptance test
  -> discover organization_id tables
  -> verify registry, RLS, policies, and runtime grants
```

If the event-trigger implementation becomes too complex, design E retains most of the benefit with lower operational risk. The fallback should still use the registry and profiles rather than returning to an unstructured central table-name list.

## Questions for expert review

1. Can the event-trigger functions safely apply `ALTER TABLE`, `CREATE POLICY`, and `GRANT` without undesirable recursion in the supported PostgreSQL version?
2. Should future table migrations insert registry metadata in the same changeset as `CREATE TABLE`, or should a controlled helper own table creation?
3. Which DDL operations must be blocked or revalidated: table creation, rename, column changes, partition attachment, and table drop?
4. Should platform/global tables also require a registry entry, even though they receive no runtime grants by default?
5. Is PostgreSQL-specific event-trigger machinery acceptable for the deployment and self-hosted support model?
6. Should the acceptance test verify exact grants per capability profile, or only verify that unregistered tables have no runtime grants?
7. Do Liquibase changesets execute in transactions in every supported deployment mode, and can runtime traffic be guaranteed not to run during schema changes?

## References

- PostgreSQL `ALTER DEFAULT PRIVILEGES`: https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html
- PostgreSQL event trigger behavior: https://www.postgresql.org/docs/18/event-trigger-definition.html
- PostgreSQL event-trigger catalog inspection: https://www.postgresql.org/docs/17/functions-event-triggers.html
