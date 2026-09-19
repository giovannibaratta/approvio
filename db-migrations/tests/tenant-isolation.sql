-- PostgreSQL RLS and least-privilege acceptance test.
--
-- This is deliberately separate from the TypeScript integration suite. That suite creates a
-- separate database per test run to prevent test-data interference. This script instead proves
-- that two organizations sharing one database remain isolated when the application uses its
-- restricted runtime roles.
--
-- `yarn test:tenant-isolation` prepares the disposable integration-test database, runs this file
-- through psql as the bootstrap administrator, and rolls back all fixtures below. The rollback is
-- required: Jest clones this database as its test template and must not inherit these SQL fixtures.

\set ON_ERROR_STOP on

BEGIN;

-- 1. Verify role attributes, grants and ownership before exercising application data.
DO $$
DECLARE
  -- Number of runtime roles with login or privilege attributes that could bypass the intended boundary.
  insecure_role_count integer;
  -- Names of tenant tables missing either ENABLE ROW LEVEL SECURITY or FORCE ROW LEVEL SECURITY.
  missing_rls_tables text;
  -- Names of public tables absent from the security table registry.
  unregistered_tables text;
  -- Names of registered tables whose security registration has not been activated.
  inactive_security_tables text;
  -- Tracks whether the database rejected an attempt to assign an incompatible security profile.
  profile_mismatch_rejected boolean := false;
BEGIN
  -- A runtime role with any of these attributes can escape the intended capability boundary:
  -- login permits direct use, inheritance/role creation can acquire other capabilities, and superuser/
  -- bypass-RLS can read or write every tenant. This must remain zero for every runtime role.
  SELECT count(*) INTO insecure_role_count
  FROM pg_roles
  WHERE rolname IN (
    'approvio_tenant_runtime', 'approvio_identity_runtime', 'approvio_session_runtime',
    'approvio_discovery_runtime', 'approvio_provisioning_runtime', 'approvio_scheduler_runtime',
    'approvio_worker_runtime', 'approvio_audit_runtime', 'approvio_metering_runtime',
    'approvio_security_runtime'
  ) AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR rolcanlogin);

  IF insecure_role_count <> 0 THEN
    -- Reaching this point means at least one runtime role can bypass the intended boundary; fail the test.
    RAISE EXCEPTION 'runtime role has an unsafe role attribute';
  END IF;

  -- Tenant runtime must not create schema objects, truncate tenant history, or read Liquibase's
  -- change history. Any of those privileges turns a request-processing credential into a database
  -- administration credential and can bypass auditability or isolation controls.
  IF has_schema_privilege('approvio_tenant_runtime', 'public', 'CREATE')
    OR has_table_privilege('approvio_tenant_runtime', 'users', 'TRUNCATE')
    OR has_table_privilege('approvio_tenant_runtime', 'databasechangelog', 'SELECT') THEN
    -- Reaching this point means the tenant role has a forbidden privilege; fail the test.
    RAISE EXCEPTION 'tenant runtime has DDL, TRUNCATE, or migration metadata privileges';
  END IF;

  IF NOT has_table_privilege('approvio_tenant_runtime', 'tenant_event_receipts', 'SELECT')
    OR NOT has_table_privilege('approvio_tenant_runtime', 'tenant_event_receipts', 'INSERT')
    OR has_table_privilege('approvio_tenant_runtime', 'tenant_event_receipts', 'UPDATE')
    OR has_table_privilege('approvio_tenant_runtime', 'tenant_event_receipts', 'DELETE')
    OR NOT has_table_privilege('approvio_worker_runtime', 'tenant_event_receipts', 'SELECT')
    OR NOT has_table_privilege('approvio_worker_runtime', 'tenant_event_receipts', 'INSERT')
    OR has_table_privilege('approvio_worker_runtime', 'tenant_event_receipts', 'UPDATE')
    OR has_table_privilege('approvio_worker_runtime', 'tenant_event_receipts', 'DELETE') THEN
    -- Reaching this point means event receipt grants differ from the required read/insert-only profile.
    RAISE EXCEPTION 'event receipt runtime privileges do not match the read/insert-only profile';
  END IF;

  IF NOT has_table_privilege('approvio_tenant_runtime', 'quotas', 'DELETE')
    OR has_table_privilege('approvio_metering_runtime', 'quotas', 'SELECT')
    OR has_table_privilege('approvio_metering_runtime', 'quotas', 'INSERT')
    OR has_table_privilege('approvio_metering_runtime', 'quotas', 'UPDATE') THEN
    -- Reaching this point means quota grants differ from the required tenant CRUD profile.
    RAISE EXCEPTION 'quota runtime privileges do not match the tenant CRUD profile';
  END IF;

  -- Each process login may assume only its capability set. A tenant credential with discovery,
  -- worker, or platform capabilities could enumerate or mutate data outside a request's tenant;
  -- platform/worker credentials with tenant capability could reach customer data unexpectedly.
  IF NOT pg_has_role('approvio_tenant', 'approvio_tenant_runtime', 'MEMBER')
    OR pg_has_role('approvio_tenant', 'approvio_discovery_runtime', 'MEMBER')
    OR NOT pg_has_role('approvio_platform', 'approvio_identity_runtime', 'MEMBER')
    OR NOT pg_has_role('approvio_platform', 'approvio_security_runtime', 'MEMBER')
    OR pg_has_role('approvio_platform', 'approvio_tenant_runtime', 'MEMBER')
    OR NOT pg_has_role('approvio_worker', 'approvio_worker_runtime', 'MEMBER')
    OR pg_has_role('approvio_worker', 'approvio_tenant_runtime', 'MEMBER') THEN
    -- Reaching this point means a login has the wrong capability memberships; fail the test.
    RAISE EXCEPTION 'runtime login capability membership is incorrect';
  END IF;

  -- Runtime roles must not own relations: a PostgreSQL owner can bypass normal grant boundaries.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_roles owner_role ON owner_role.oid = c.relowner
    WHERE c.relnamespace = 'public'::regnamespace
      AND owner_role.rolname LIKE 'approvio_%_runtime'
  ) THEN
    -- Reaching this point means a runtime role owns a public relation and can bypass grant checks.
    RAISE EXCEPTION 'a runtime role owns a public relation';
  END IF;

  -- Every non-null public organization_id column marks a tenant-owned table. Discover them from
  -- PostgreSQL metadata so a new tenant table fails this test until its migration enables and
  -- forces RLS; no hand-maintained table count is needed.
  SELECT string_agg(table_class.relname, ', ' ORDER BY table_class.relname) INTO missing_rls_tables
  FROM pg_class table_class
  JOIN pg_attribute organization_column
    ON organization_column.attrelid = table_class.oid
   AND organization_column.attname = 'organization_id'
   AND organization_column.attnotnull
   AND NOT organization_column.attisdropped
  WHERE table_class.relnamespace = 'public'::regnamespace
    -- pg_class.relkind 'r' means an ordinary table; 'p' means a partitioned table.
    -- Exclude views, indexes, sequences and other relation kinds from table security checks.
    AND table_class.relkind IN ('r', 'p')
    AND (NOT table_class.relrowsecurity OR NOT table_class.relforcerowsecurity);

  IF missing_rls_tables IS NOT NULL THEN
    -- Reaching this point means one or more tenant tables lack enabled and forced RLS; fail the test.
    RAISE EXCEPTION 'tenant tables without ENABLE and FORCE RLS: %', missing_rls_tables;
  END IF;

  SELECT string_agg(table_class.relname, ', ' ORDER BY table_class.relname)
  INTO unregistered_tables
  FROM pg_class AS table_class
  LEFT JOIN approvio_security_table_registry AS security_table
    ON security_table.table_name = table_class.relname
  WHERE table_class.relnamespace = 'public'::regnamespace
    -- Use the same table kinds as the RLS check above: ordinary and partitioned tables.
    AND table_class.relkind IN ('r', 'p')
    AND table_class.relname NOT IN (
      'approvio_security_table_registry',
      'approvio_security_capability_profiles',
      'approvio_security_profile_grants',
      'approvio_security_settings'
    )
    AND security_table.table_name IS NULL;

  IF unregistered_tables IS NOT NULL THEN
    -- Reaching this point means a public table has no security registry entry; fail the test.
    RAISE EXCEPTION 'public tables without security registration: %', unregistered_tables;
  END IF;

  SELECT string_agg(security_table.table_name, ', ' ORDER BY security_table.table_name)
  INTO inactive_security_tables
  FROM approvio_security_table_registry AS security_table
  WHERE security_table.status <> 'active';

  IF inactive_security_tables IS NOT NULL THEN
    -- Reaching this point means one or more table registrations are inactive; fail the test.
    RAISE EXCEPTION 'security registrations are not active: %', inactive_security_tables;
  END IF;

  BEGIN
    INSERT INTO approvio_security_table_registry(table_name, security_class, capability_profile)
    VALUES ('approvio_profile_mismatch_probe', 'tenant', 'platform_accounts');
    CREATE TABLE approvio_profile_mismatch_probe (organization_id uuid NOT NULL);
  -- Reaching this handler means the trigger rejected the incompatible profile; verify its error and mark success.
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'capability profile % is not compatible with security class %' THEN
      -- An unexpected trigger error does not prove the profile check works; propagate it and fail the test.
      RAISE;
    END IF;
    profile_mismatch_rejected := true;
  END;

  IF NOT profile_mismatch_rejected THEN
    -- Reaching this point means the incompatible profile was accepted; fail the test.
    RAISE EXCEPTION 'security trigger accepted an incompatible capability profile';
  END IF;
END
$$;

-- 2. Seed the shared test fixture as the bootstrap administrator. These successful inserts create
-- the organizations and related rows used by the assertions below. The enclosing transaction rolls
-- the fixture back at the end of the script.
INSERT INTO organizations(id, slug, display_name, plan_tier, status, occ, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'tenant-one', 'Tenant One', 'FREE', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'tenant-two', 'Tenant Two', 'FREE', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO platform_accounts(id, display_name, profile_email, status, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Account One', 'account-one@example.com', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000102', 'Account Two', 'account-two@example.com', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO users(id, organization_id, platform_account_id, display_name, status, org_role, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'User One', 'active', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000102', 'User Two', 'active', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO agents(id, organization_id, agent_name, base64_public_key, status, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000002', 'agent-two', 'dGVzdC1wdWJsaWMta2V5', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000001', 'group-one', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000002', 'group-two', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO spaces(id, organization_id, name, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000001', 'space-one', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000002', 'space-two', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO workflow_templates(
  id, organization_id, name, approval_rule, created_at, updated_at, status, version,
  allow_voting_on_deprecated_template, occ, space_id
) VALUES (
  '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000001',
  'template-one', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active', 1, false, 1, '00000000-0000-0000-0000-000000000401'
);
INSERT INTO workflows(
  id, organization_id, name, created_at, updated_at, status, occ, recalculation_required, workflow_template_id, expires_at
) VALUES (
  '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000001',
  'workflow-one', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'PENDING', 1, false, '00000000-0000-0000-0000-000000000501', '2026-01-02T00:00:00Z'
);
INSERT INTO votes(id, organization_id, workflow_id, user_id, vote_type, voted_for_groups, created_at) VALUES (
  '00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000201', 'APPROVE', '{}', '2026-01-01T00:00:00Z'
);
INSERT INTO audit_logs(
  id, organization_id, audit_type, entity_type, entity_id, actor_id, actor_type,
  actor_display_name, payload, schema_version, created_at
) VALUES (
  '00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000001',
  'VOTE_CREATED', 'WORKFLOW', '00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-000000000201', 'USER', 'User One', '{}', 1, '2026-01-01T00:00:00Z'
);

-- 3. Assert tenant-matching composite foreign keys reject cross-organization relationships.
-- These inserts are deliberately invalid probes, not fixture setup. Each INSERT runs in a nested
-- PL/pgSQL block so its expected foreign_key_violation is caught and its row is rolled back.
DO $$
BEGIN
  BEGIN
    INSERT INTO group_memberships(organization_id, group_id, user_id, created_at, updated_at) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000301',
      '00000000-0000-0000-0000-000000000202',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    -- Reaching this point means the invalid cross-organization insert succeeded, so fail the test.
    RAISE EXCEPTION 'cross-organization group membership unexpectedly succeeded';
  -- Reaching this handler means the composite foreign key rejected the insert, so the test passes.
  EXCEPTION WHEN foreign_key_violation THEN
    -- The expected constraint error was raised, so this assertion passes.
    NULL;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO agent_group_memberships(organization_id, group_id, agent_id, created_at, updated_at) VALUES (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000301',
      '00000000-0000-0000-0000-000000000211',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    -- Reaching this point means the invalid cross-organization insert succeeded, so fail the test.
    RAISE EXCEPTION 'cross-organization agent group membership unexpectedly succeeded';
  -- Reaching this handler means the composite foreign key rejected the insert, so the test passes.
  EXCEPTION WHEN foreign_key_violation THEN
    -- The expected constraint error was raised, so this assertion passes.
    NULL;
  END;
END
$$;

-- 4. Switch from the bootstrap administrator to the role used by organization-scoped requests.
SET LOCAL ROLE approvio_tenant_runtime;

-- Missing transaction context must reveal no tenant rows and reject writes. Without this, a
-- repository that forgets to establish organization context could read every tenant or write a
-- row detached from the caller's authority.
DO $$
BEGIN
  IF (SELECT count(*) FROM groups) <> 0 THEN
    -- Reaching this point means tenant rows are visible without context; fail the test.
    RAISE EXCEPTION 'tenant rows are visible without organization context';
  END IF;

  BEGIN
    INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES (
      '00000000-0000-0000-0000-000000000303',
      '00000000-0000-0000-0000-000000000001',
      'missing-context-write', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1
    );
    -- Reaching this point means a tenant write succeeded without context; fail the test.
    RAISE EXCEPTION 'tenant write without organization context unexpectedly succeeded';
  -- Reaching this handler means PostgreSQL rejected the context-free write, so the assertion passes.
  EXCEPTION WHEN insufficient_privilege THEN
    -- The expected privilege error was raised, so this assertion passes.
    NULL;
  END;
END
$$;

-- With organization one selected, only its rows are visible and writes must remain within it.
SET LOCAL approvio.organization_id = '00000000-0000-0000-0000-000000000001';

DO $$
DECLARE
  visible_groups integer;
BEGIN
  SELECT count(*) INTO visible_groups FROM groups;
  IF visible_groups <> 1 THEN
    -- Reaching this point means RLS returned the wrong number of organization-one groups; fail the test.
    RAISE EXCEPTION 'tenant RLS exposed a foreign group';
  END IF;

  BEGIN
    INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES (
      '00000000-0000-0000-0000-000000000303',
      '00000000-0000-0000-0000-000000000002',
      'foreign-write', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1
    );
    -- Reaching this point means the tenant role wrote into organization two; fail the test.
    RAISE EXCEPTION 'cross-organization insert unexpectedly succeeded';
  -- Reaching this handler means RLS rejected the foreign write, so the assertion passes.
  EXCEPTION WHEN insufficient_privilege THEN
    -- The expected privilege error was raised, so this assertion passes.
    NULL;
  END;

  BEGIN
    INSERT INTO workflow_templates(
      id, organization_id, name, approval_rule, created_at, updated_at, status, version,
      allow_voting_on_deprecated_template, occ, space_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000502',
      '00000000-0000-0000-0000-000000000001',
      'cross-org-template', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active', 1, false, 1,
      '00000000-0000-0000-0000-000000000402'
    );
    -- Reaching this point means a template referenced another organization's space; fail the test.
    RAISE EXCEPTION 'cross-organization foreign key unexpectedly succeeded';
  -- Reaching this handler means the composite foreign key rejected the mismatch, so the test passes.
  EXCEPTION WHEN foreign_key_violation THEN
    -- The expected constraint error was raised, so this assertion passes.
    NULL;
  END;

  BEGIN
    UPDATE groups
    SET organization_id = '00000000-0000-0000-0000-000000000002'
    WHERE id = '00000000-0000-0000-0000-000000000301';
    -- Reaching this point means the tenant role changed the row's organization; fail the test.
    RAISE EXCEPTION 'organization ownership update unexpectedly succeeded';
  -- Reaching this handler means RLS rejected changing organization ownership, so the test passes.
  EXCEPTION WHEN insufficient_privilege THEN
    -- The expected privilege error was raised, so this assertion passes.
    NULL;
  END;
END
$$;

-- 5. Preserve historical attribution. Removing a local user must not remove its vote or audit
-- record, while ordinary membership changes remain valid inside the current organization.
SET LOCAL ROLE approvio_tenant_runtime;
SET LOCAL approvio.organization_id = '00000000-0000-0000-0000-000000000001';

INSERT INTO group_memberships(organization_id, group_id, user_id, created_at, updated_at) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000301',
  '00000000-0000-0000-0000-000000000201', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);

DO $$
BEGIN
  BEGIN
    DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000201';
    -- Reaching this point means historical vote/audit attribution did not prevent user deletion.
    RAISE EXCEPTION 'historical voter deletion unexpectedly succeeded';
  -- Reaching this handler means the attribution foreign key prevented deletion, so the test passes.
  EXCEPTION WHEN foreign_key_violation THEN
    -- The expected constraint error was raised, so this assertion passes.
    NULL;
  END;

  UPDATE users
  SET status = 'removed', roles = NULL
  WHERE id = '00000000-0000-0000-0000-000000000201';

  IF (SELECT count(*) FROM votes WHERE id = '00000000-0000-0000-0000-000000000701') <> 1
    OR (SELECT count(*) FROM audit_logs WHERE id = '00000000-0000-0000-0000-000000000801') <> 1 THEN
    -- Reaching this point means deleting the user removed historical attribution; fail the test.
    RAISE EXCEPTION 'principal removal lost vote or audit attribution';
  END IF;
END
$$;

ROLLBACK;
