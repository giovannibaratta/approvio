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
  insecure_role_count integer;
  missing_rls_tables text;
BEGIN
  -- A runtime role with any of these attributes can escape the intended capability boundary:
  -- login permits direct use, inheritance/role creation can acquire other capabilities, and superuser/
  -- bypass-RLS can read or write every tenant. This must remain zero for every runtime role.
  SELECT count(*) INTO insecure_role_count
  FROM pg_roles
  WHERE rolname IN (
    'approvio_tenant_runtime', 'approvio_identity_runtime', 'approvio_session_runtime',
    'approvio_discovery_runtime', 'approvio_provisioning_runtime', 'approvio_scheduler_runtime',
    'approvio_worker_runtime', 'approvio_audit_runtime', 'approvio_metering_runtime'
  ) AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR rolcanlogin);

  IF insecure_role_count <> 0 THEN
    RAISE EXCEPTION 'runtime role has an unsafe role attribute';
  END IF;

  -- Tenant runtime must not create schema objects, truncate tenant history, or read Liquibase's
  -- change history. Any of those privileges turns a request-processing credential into a database
  -- administration credential and can bypass auditability or isolation controls.
  IF has_schema_privilege('approvio_tenant_runtime', 'public', 'CREATE')
    OR has_table_privilege('approvio_tenant_runtime', 'users', 'TRUNCATE')
    OR has_table_privilege('approvio_tenant_runtime', 'databasechangelog', 'SELECT') THEN
    RAISE EXCEPTION 'tenant runtime has DDL, TRUNCATE, or migration metadata privileges';
  END IF;

  -- Each process login may assume only its capability set. A tenant credential with discovery,
  -- worker, or platform capabilities could enumerate or mutate data outside a request's tenant;
  -- platform/worker credentials with tenant capability could reach customer data unexpectedly.
  IF NOT pg_has_role('approvio_tenant', 'approvio_tenant_runtime', 'MEMBER')
    OR pg_has_role('approvio_tenant', 'approvio_discovery_runtime', 'MEMBER')
    OR NOT pg_has_role('approvio_platform', 'approvio_identity_runtime', 'MEMBER')
    OR pg_has_role('approvio_platform', 'approvio_tenant_runtime', 'MEMBER')
    OR NOT pg_has_role('approvio_worker', 'approvio_worker_runtime', 'MEMBER')
    OR pg_has_role('approvio_worker', 'approvio_tenant_runtime', 'MEMBER') THEN
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
    AND table_class.relkind IN ('r', 'p')
    AND (NOT table_class.relrowsecurity OR NOT table_class.relforcerowsecurity);

  IF missing_rls_tables IS NOT NULL THEN
    RAISE EXCEPTION 'tenant tables without ENABLE and FORCE RLS: %', missing_rls_tables;
  END IF;
END
$$;

-- 2. Set up two organizations and enough related data to test reads, writes, tenant-matching
-- foreign keys and durable attribution. The enclosing transaction rolls
-- this fixture back.
INSERT INTO organizations(id, slug, display_name, status, occ, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'tenant-one', 'Tenant One', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'tenant-two', 'Tenant Two', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO platform_accounts(id, display_name, status, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000101', 'Account One', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000102', 'Account Two', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
INSERT INTO users(id, organization_id, platform_account_id, display_name, status, org_role, created_at, updated_at, occ) VALUES
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', 'User One', 'active', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000102', 'User Two', 'active', 'owner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
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

-- 3. Switch from the bootstrap administrator to the role used by organization-scoped requests.
SET LOCAL ROLE approvio_tenant_runtime;

-- Missing transaction context must reveal no tenant rows and reject writes. Without this, a
-- repository that forgets to establish organization context could read every tenant or write a
-- row detached from the caller's authority.
DO $$
BEGIN
  IF (SELECT count(*) FROM groups) <> 0 THEN
    RAISE EXCEPTION 'tenant rows are visible without organization context';
  END IF;

  BEGIN
    INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES (
      '00000000-0000-0000-0000-000000000303',
      '00000000-0000-0000-0000-000000000001',
      'missing-context-write', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1
    );
    RAISE EXCEPTION 'tenant write without organization context unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
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
    RAISE EXCEPTION 'tenant RLS exposed a foreign group';
  END IF;

  BEGIN
    INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES (
      '00000000-0000-0000-0000-000000000303',
      '00000000-0000-0000-0000-000000000002',
      'foreign-write', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1
    );
    RAISE EXCEPTION 'cross-organization insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
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
    RAISE EXCEPTION 'cross-organization foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE groups
    SET organization_id = '00000000-0000-0000-0000-000000000002'
    WHERE id = '00000000-0000-0000-0000-000000000301';
    RAISE EXCEPTION 'organization ownership update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

-- 4. Preserve historical attribution. Removing a local user must not remove its vote or audit
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
    RAISE EXCEPTION 'historical voter deletion unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  UPDATE users
  SET status = 'removed', roles = NULL
  WHERE id = '00000000-0000-0000-0000-000000000201';

  IF (SELECT count(*) FROM votes WHERE id = '00000000-0000-0000-0000-000000000701') <> 1
    OR (SELECT count(*) FROM audit_logs WHERE id = '00000000-0000-0000-0000-000000000801') <> 1 THEN
    RAISE EXCEPTION 'principal removal lost vote or audit attribution';
  END IF;
END
$$;

ROLLBACK;
