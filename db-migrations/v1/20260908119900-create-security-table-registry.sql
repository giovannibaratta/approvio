-- Security bootstrap
--
-- This file runs before the application tables are created. It defines the database roles, permission
-- profiles, and table registry used by the DDL event trigger below.
--
-- Terms used in this file:
-- - A database role is a set of permissions. Runtime roles such as approvio_worker_runtime are
--   NOLOGIN roles; application logins may assume only the runtime roles granted to them.
-- - A capability profile is a named permission bundle selected by a table in the security registry.
--   It groups the SQL grants and row-access scopes for that table.
-- - A grant gives a role permission to run SQL operations (such as SELECT or UPDATE), optionally
--   limited to named columns. A grant does not decide which rows the role can use.
-- - A policy scope decides which rows a role can see or change. For example, organization_context
--   limits a role to rows whose id matches the transaction's approvio.organization_id setting.
--   A scope does not grant SELECT, UPDATE, or any other SQL operation by itself.
-- - A security class selects the table's row key and isolation mode: tenant uses organization_id,
--   organization uses a UUID id, tenant_with_discovery permits profile-declared global reads, and
--   platform tables are not filtered by the current organization; profile grants control table and
--   column access.
--
-- How a table gets secured:
-- 1. Its Liquibase migration inserts a pending registry row immediately before CREATE TABLE, naming
--    the table's security class and capability profile.
-- 2. The DDL event trigger reads that row, checks the table shape and that each granted role has a
--    compatible policy scope, then enables and forces row-level security where required.
-- 3. The trigger creates row policies from the profile scopes, issues the profile's SQL grants, and
--    marks the registry row active. Creating an unregistered public table fails.
--
-- Example: an example_tenant_table selects example_profile. That profile grants
-- example_runtime_role SELECT on id/status and assigns tenant_context. The trigger combines both:
-- the role can read only those columns and only rows whose organization_id matches its context.

-- Runtime roles are non-login capabilities: they describe database permissions, not credentials.
-- Each application connection uses a login role and can assume only the capability roles it needs.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'approvio_tenant_runtime', 'approvio_identity_runtime', 'approvio_session_runtime',
    'approvio_discovery_runtime', 'approvio_provisioning_runtime', 'approvio_scheduler_runtime',
    'approvio_worker_runtime', 'approvio_audit_runtime', 'approvio_metering_runtime',
    'approvio_security_runtime'
  ] LOOP
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
      role_name
    );
  END LOOP;
END
$$;

-- Login principals and their credentials are provisioned outside Liquibase. These grants attach the
-- non-secret capability roles to those logins; they do not grant a login every runtime capability.
GRANT approvio_tenant_runtime TO approvio_tenant;
GRANT approvio_identity_runtime, approvio_session_runtime,
  approvio_discovery_runtime, approvio_provisioning_runtime TO approvio_platform;
GRANT approvio_worker_runtime, approvio_scheduler_runtime TO approvio_worker;
GRANT approvio_security_runtime TO approvio_platform;

-- Startup validation reads only migration identifiers, never other Liquibase metadata.
GRANT SELECT (id) ON TABLE public.databasechangelog
  TO approvio_tenant, approvio_platform, approvio_worker;

-- One row per application table is the declaration consumed by the DDL trigger.
-- security_class chooses the row key and isolation mode; capability_profile defines grants and
-- role-specific row scopes.
-- status is a small lifecycle: pending before CREATE TABLE, applying while the trigger configures it,
-- active only after policies and grants have been installed.
CREATE TABLE approvio_security_table_registry (
  table_name text PRIMARY KEY,
  security_class text NOT NULL CHECK (security_class IN ('tenant', 'tenant_with_discovery', 'organization', 'platform')),
  capability_profile text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'active'))
);

-- Profiles, grants, and row scopes are owned centrally by this bootstrap. Table migrations may
-- choose a named profile, but cannot define permissions alongside an individual table.
CREATE TABLE approvio_security_capability_profiles (
  profile_name text PRIMARY KEY
);

-- Each row becomes a separate GRANT statement. Multiple rows per role allow different column sets
-- for different privileges without broadening either grant.
CREATE TABLE approvio_security_profile_grants (
  grant_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_name text NOT NULL REFERENCES approvio_security_capability_profiles(profile_name),
  role_name text NOT NULL,
  privileges text[] NOT NULL,
  columns text[]
);

-- Row access belongs to the capability profile too. Each role is assigned a fixed policy scope;
-- the trigger below maps these scopes to reviewed predicates instead of naming roles per table.
CREATE TABLE approvio_security_profile_policies (
  profile_name text NOT NULL REFERENCES approvio_security_capability_profiles(profile_name),
  role_name text NOT NULL,
  policy_scope text NOT NULL CHECK (policy_scope IN (
    'tenant_context', 'organization_context', 'global_read', 'global_insert'
  )),
  PRIMARY KEY (profile_name, role_name)
);

-- Named grant and row-scope combinations available to table migrations.
INSERT INTO approvio_security_capability_profiles(profile_name)
VALUES
  ('organization'),
  ('platform_accounts'),
  ('platform_account_identities'),
  ('platform_sessions'),
  ('platform_security_events'),
  ('tenant_crud'),
  ('tenant_workflow_read'),
  ('tenant_workflow_update'),
  ('tenant_workflow_schedule'),
  ('tenant_with_discovery'),
  ('tenant_outbox'),
  ('tenant_worker'),
  ('tenant_usage'),
  ('tenant_usage_events'),
  ('tenant_usage_worker_snapshot'),
  ('tenant_usage_worker_events'),
  ('tenant_usage_worker_settlements'),
  ('tenant_audit'),
  ('tenant_event_receipts'),
  ('platform_none');

-- Each row grants the listed SQL privileges to one capability role for one profile.
-- NULL columns means the grant applies to the whole table; a column array narrows the grant to those
-- columns. Keep profiles operation-based and least-privilege: tables with different repository needs
-- should use different profiles rather than broadening a shared profile for one special case.
INSERT INTO approvio_security_profile_grants(profile_name, role_name, privileges, columns)
VALUES
  -- Organization records use tenant-scoped reads/inserts/updates and broad discovery/scheduler reads.
  ('organization', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('organization', 'approvio_discovery_runtime', ARRAY['SELECT'], NULL),
  ('organization', 'approvio_scheduler_runtime', ARRAY['SELECT'], NULL),
  ('organization', 'approvio_provisioning_runtime', ARRAY['INSERT'], NULL),
  ('organization', 'approvio_worker_runtime', ARRAY['SELECT'], ARRAY['id', 'status']),
  -- Platform identity and session data are split by purpose. Session code can read accounts, while
  -- identity code owns account writes; sessions have a narrower profile.
  ('platform_accounts', 'approvio_identity_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('platform_accounts', 'approvio_session_runtime', ARRAY['SELECT'], NULL),
  -- Tenant user search joins account IDs and matches exact profile emails.
  ('platform_accounts', 'approvio_tenant_runtime', ARRAY['SELECT'], ARRAY['id', 'profile_email']),
  ('platform_account_identities', 'approvio_identity_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('platform_sessions', 'approvio_session_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('platform_security_events', 'approvio_security_runtime', ARRAY['INSERT'], NULL),
  -- Tenant tables use row-level isolation; discovery access, when needed, is column-limited.
  ('tenant_crud', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  -- Workflow execution shares tenant repositories with narrower worker write permissions.
  ('tenant_workflow_read', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('tenant_workflow_update', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('tenant_workflow_schedule', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('tenant_workflow_read', 'approvio_worker_runtime', ARRAY['SELECT'], NULL),
  ('tenant_workflow_update', 'approvio_worker_runtime', ARRAY['SELECT'], NULL),
  ('tenant_workflow_update', 'approvio_worker_runtime', ARRAY['UPDATE'], ARRAY['status', 'occ', 'recalculation_required', 'updated_at']),
  ('tenant_workflow_schedule', 'approvio_worker_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_with_discovery', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('tenant_with_discovery', 'approvio_discovery_runtime', ARRAY['SELECT'], ARRAY['id', 'organization_id', 'platform_account_id', 'status']),
  ('tenant_with_discovery', 'approvio_provisioning_runtime', ARRAY['INSERT'], NULL),
  -- Outbox rows are written by tenant code and claimed/updated by workers. Worker task data is
  -- available to workers only. Usage profiles separate operational writes from append-only events.
  ('tenant_outbox', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_outbox', 'approvio_worker_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_worker', 'approvio_worker_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage', 'approvio_metering_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage_events', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_usage_events', 'approvio_metering_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  -- Reconciliation reads billing facts; workers may only acknowledge settlement intents.
  ('tenant_usage_worker_snapshot', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage_worker_snapshot', 'approvio_metering_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage_worker_snapshot', 'approvio_worker_runtime', ARRAY['SELECT'], NULL),
  ('tenant_usage_worker_events', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_usage_worker_events', 'approvio_metering_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_usage_worker_events', 'approvio_worker_runtime', ARRAY['SELECT'], NULL),
  ('tenant_usage_worker_settlements', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage_worker_settlements', 'approvio_metering_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('tenant_usage_worker_settlements', 'approvio_worker_runtime', ARRAY['SELECT'], NULL),
  ('tenant_usage_worker_settlements', 'approvio_worker_runtime', ARRAY['UPDATE'], ARRAY['applied_at']),
  -- Receipts and audit history are append-only for their writers; these profiles intentionally
  -- withhold UPDATE and DELETE. Metering has access only to the usage operations it performs.
  ('tenant_event_receipts', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_event_receipts', 'approvio_worker_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_audit', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_audit', 'approvio_audit_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_audit', 'approvio_provisioning_runtime', ARRAY['INSERT'], NULL);

-- A profile grants SQL capabilities and assigns each granted role its row-access scope.
-- Predicate definitions remain fixed in the trigger; this metadata only chooses a scope.
INSERT INTO approvio_security_profile_policies(profile_name, role_name, policy_scope)
VALUES
  ('organization', 'approvio_tenant_runtime', 'organization_context'),
  ('organization', 'approvio_worker_runtime', 'organization_context'),
  ('organization', 'approvio_discovery_runtime', 'global_read'),
  ('organization', 'approvio_scheduler_runtime', 'global_read'),
  ('organization', 'approvio_provisioning_runtime', 'global_insert'),
  ('tenant_crud', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_workflow_read', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_workflow_read', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_workflow_update', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_workflow_update', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_workflow_schedule', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_workflow_schedule', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_with_discovery', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_with_discovery', 'approvio_discovery_runtime', 'global_read'),
  ('tenant_with_discovery', 'approvio_provisioning_runtime', 'tenant_context'),
  ('tenant_outbox', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_outbox', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_worker', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_usage', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_usage', 'approvio_metering_runtime', 'tenant_context'),
  ('tenant_usage_events', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_usage_events', 'approvio_metering_runtime', 'tenant_context'),
  ('tenant_usage_worker_snapshot', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_usage_worker_snapshot', 'approvio_metering_runtime', 'tenant_context'),
  ('tenant_usage_worker_snapshot', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_usage_worker_events', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_usage_worker_events', 'approvio_metering_runtime', 'tenant_context'),
  ('tenant_usage_worker_events', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_usage_worker_settlements', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_usage_worker_settlements', 'approvio_metering_runtime', 'tenant_context'),
  ('tenant_usage_worker_settlements', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_event_receipts', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_event_receipts', 'approvio_worker_runtime', 'tenant_context'),
  ('tenant_audit', 'approvio_tenant_runtime', 'tenant_context'),
  ('tenant_audit', 'approvio_audit_runtime', 'tenant_context'),
  ('tenant_audit', 'approvio_provisioning_runtime', 'tenant_context');

-- Liquibase creates its changelog tables before applying this root changelog, so the event trigger
-- cannot require prior declarations for them. Register them as already active platform metadata with
-- the empty platform_none profile; no runtime role receives table privileges through this profile.
INSERT INTO approvio_security_table_registry(table_name, security_class, capability_profile, status)
VALUES
  ('databasechangelog', 'platform', 'platform_none', 'active'),
  ('databasechangeloglock', 'platform', 'platform_none', 'active');

-- The event trigger is the enforcement point. A table migration declares intent; this function verifies
-- that declaration and applies the actual PostgreSQL security before the CREATE TABLE transaction ends.
-- SECURITY DEFINER is required to install policies and grants. A fixed search_path avoids inheriting
-- a caller-controlled lookup path, with pg_catalog searched before the application schema.
CREATE OR REPLACE FUNCTION approvio_apply_security_to_created_tables() RETURNS event_trigger
LANGUAGE plpgsql
-- Runs with this function's owner's privileges, not the role issuing CREATE TABLE. This lets the
-- trigger install RLS policies and grants; keep its body and search_path tightly controlled.
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Current table command and its pending security declaration.
  command_record record;
  registration record;
  -- Current profile grant while materializing the selected capability profile.
  profile_grant record;
  -- Current row-access scope while materializing the selected capability profile.
  profile_policy record;
  created_table_name text;
  -- Roles grouped by policy scope, plus the fixed SQL form selected for that scope.
  policy_roles text;
  policy_command text;
  policy_predicate text;
  policy_name text;
  -- Validation and SQL-formatting scratch values.
  context_column_exists boolean;
  invalid_privilege text;
  grant_columns text;
  -- Never allow a profile to execute a broader table-level privilege through this trigger.
  allowed_privileges constant text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
BEGIN
  -- One DDL command can create several tables. Process each public table independently, using its
  -- catalog OID rather than trusting a name supplied by migration SQL.
  FOR command_record IN
    SELECT command.objid
    FROM pg_event_trigger_ddl_commands() AS command
    WHERE command.object_type = 'table'
      AND command.schema_name = 'public'
  LOOP
    SELECT relation.relname
    INTO created_table_name
    FROM pg_class AS relation
    WHERE relation.oid = command_record.objid;

    -- Ignore the bootstrap metadata tables. They are created before this mechanism is installed and
    -- must not recursively receive application-table security configuration.
    IF created_table_name IS NULL
       OR created_table_name IN (
         'approvio_security_table_registry',
         'approvio_security_capability_profiles',
         'approvio_security_profile_grants',
         'approvio_security_profile_policies'
       ) THEN
      CONTINUE;
    END IF;

    -- Only a pending declaration authorizes creation. Missing, already-consumed, or active entries
    -- cannot be reused to create another table.
    SELECT *
    INTO registration
    FROM approvio_security_table_registry
    WHERE table_name = created_table_name
      AND status = 'pending';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'public table must be registered before creation: %', created_table_name;
    END IF;

    -- Mark the declaration as in progress. Any later exception aborts this DDL transaction, so the
    -- table and this status change roll back together instead of leaving partial security state.
    UPDATE approvio_security_table_registry
    SET status = 'applying'
    WHERE table_name = created_table_name;

    -- Reject typos and profiles not defined by this bootstrap before applying any grant.
    IF NOT EXISTS (
      SELECT 1
      FROM approvio_security_capability_profiles
      WHERE profile_name = registration.capability_profile
    ) THEN
      RAISE EXCEPTION 'unknown capability profile: %', registration.capability_profile;
    END IF;

    -- PUBLIC receives no table privileges. Runtime access comes only from the selected profile below.
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', created_table_name);

    -- Tenant and organization classes receive RLS from the selected profile's policy scopes.
    -- Platform-class tables intentionally have no row predicate.
    IF registration.security_class IN ('tenant', 'tenant_with_discovery') THEN
      -- Tenant rows must carry a non-null organization key for both the policy comparison and the
      -- transaction context to enforce isolation consistently.
      SELECT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = command_record.objid
          AND attribute.attname = 'organization_id'
          AND attribute.attnotnull
          AND NOT attribute.attisdropped
      ) INTO context_column_exists;

      IF NOT context_column_exists THEN
        RAISE EXCEPTION 'tenant table requires NOT NULL organization_id: %', created_table_name;
      END IF;

    ELSIF registration.security_class = 'organization' THEN
      -- Organization-context tables use their UUID id as the organization key.
      SELECT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        JOIN pg_type AS column_type ON column_type.oid = attribute.atttypid
        WHERE attribute.attrelid = command_record.objid
          AND attribute.attname = 'id'
          AND attribute.attnotnull
          AND column_type.typname = 'uuid'
          AND NOT attribute.attisdropped
      ) INTO context_column_exists;

      IF NOT context_column_exists THEN
        RAISE EXCEPTION 'organization-context table requires NOT NULL UUID id: %', created_table_name;
      END IF;
    END IF;

    -- Every granted role must have exactly one row scope, and every scope must correspond to a
    -- granted role. This prevents grants from silently bypassing row policy coverage.
    IF registration.security_class = 'platform' THEN
      IF EXISTS (
         SELECT 1
         FROM approvio_security_profile_policies
         WHERE profile_name = registration.capability_profile
      ) THEN
        RAISE EXCEPTION 'platform capability profile cannot define row scopes: %', registration.capability_profile;
      END IF;
    ELSE
      IF EXISTS (
        SELECT 1
        FROM approvio_security_profile_grants AS granted_profile
        LEFT JOIN approvio_security_profile_policies AS scoped_profile
          ON scoped_profile.profile_name = granted_profile.profile_name
         AND scoped_profile.role_name = granted_profile.role_name
        WHERE granted_profile.profile_name = registration.capability_profile
          AND scoped_profile.role_name IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM approvio_security_profile_policies AS scoped_profile
        WHERE scoped_profile.profile_name = registration.capability_profile
          AND NOT EXISTS (
            SELECT 1
            FROM approvio_security_profile_grants AS matching_grant
            WHERE matching_grant.profile_name = scoped_profile.profile_name
              AND matching_grant.role_name = scoped_profile.role_name
          )
      ) THEN
        RAISE EXCEPTION 'capability profile grants and row scopes do not match: %', registration.capability_profile;
      END IF;
    END IF;

    IF registration.security_class = 'tenant' AND (
      NOT EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope = 'tenant_context'
      ) OR EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope <> 'tenant_context'
      )
    ) THEN
      RAISE EXCEPTION 'tenant capability profile has incompatible row scope: %', registration.capability_profile;
    ELSIF registration.security_class = 'tenant_with_discovery' AND (
      NOT EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope = 'tenant_context'
      ) OR EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope NOT IN ('tenant_context', 'global_read')
      )
    ) THEN
      RAISE EXCEPTION 'tenant discovery capability profile has incompatible row scope: %', registration.capability_profile;
    ELSIF registration.security_class = 'organization' AND (
      NOT EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope = 'organization_context'
      ) OR EXISTS (
        SELECT 1 FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
          AND policy_scope NOT IN ('organization_context', 'global_read', 'global_insert')
      )
    ) THEN
      RAISE EXCEPTION 'organization capability profile has incompatible row scope: %', registration.capability_profile;
    END IF;

    IF registration.security_class IN ('tenant', 'tenant_with_discovery', 'organization') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', created_table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', created_table_name);

      -- Roles with the same scope share one policy. Role names are quoted before inclusion in SQL;
      -- profile data selects a scope but never supplies a SQL predicate.
      FOR profile_policy IN
        SELECT policy_scope,
               string_agg(quote_ident(role_name), ', ' ORDER BY role_name) AS roles
        FROM approvio_security_profile_policies
        WHERE profile_name = registration.capability_profile
        GROUP BY policy_scope
      LOOP
        policy_roles := profile_policy.roles;
        policy_name := left(created_table_name, 36) || '_' || substr(md5(created_table_name || ':' || profile_policy.policy_scope), 1, 16);

        CASE profile_policy.policy_scope
          WHEN 'tenant_context' THEN
            -- Restrict existing rows and inserted/updated rows to the transaction's organization.
            policy_command := 'FOR ALL';
            policy_predicate := 'organization_id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid';
            EXECUTE format(
              'CREATE POLICY %I ON %I %s TO %s USING (%s) WITH CHECK (%s)',
              policy_name, created_table_name, policy_command, policy_roles, policy_predicate, policy_predicate
            );
          WHEN 'organization_context' THEN
            -- Organization-context tables use id as the organization key.
            policy_command := 'FOR ALL';
            policy_predicate := 'id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid';
            EXECUTE format(
              'CREATE POLICY %I ON %I %s TO %s USING (%s) WITH CHECK (%s)',
              policy_name, created_table_name, policy_command, policy_roles, policy_predicate, policy_predicate
            );
          WHEN 'global_read' THEN
            -- RLS permits reading every row; the profile's SQL grant still controls whether SELECT is allowed.
            EXECUTE format(
              'CREATE POLICY %I ON %I FOR SELECT TO %s USING (true)',
              policy_name, created_table_name, policy_roles
            );
          WHEN 'global_insert' THEN
            -- RLS permits inserting any row; the profile's SQL grant still controls whether INSERT is allowed.
            EXECUTE format(
              'CREATE POLICY %I ON %I FOR INSERT TO %s WITH CHECK (true)',
              policy_name, created_table_name, policy_roles
            );
          ELSE
            RAISE EXCEPTION 'unknown capability policy scope: %', profile_policy.policy_scope;
        END CASE;
      END LOOP;
    END IF;

    -- Materialize the selected profile only after isolation policy setup. Validate privilege names and
    -- target roles before issuing GRANT; quote identifiers and format privilege lists separately.
    FOR profile_grant IN
      SELECT role_name, privileges, columns
      FROM approvio_security_profile_grants
      WHERE profile_name = registration.capability_profile
    LOOP
      FOREACH invalid_privilege IN ARRAY profile_grant.privileges
      LOOP
        IF NOT (invalid_privilege = ANY (allowed_privileges)) THEN
          RAISE EXCEPTION 'invalid capability privilege: %', invalid_privilege;
        END IF;
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = profile_grant.role_name
      ) THEN
        RAISE EXCEPTION 'unknown capability role: %', profile_grant.role_name;
      END IF;

      -- Table-wide grants and column-limited grants use separate SQL forms. Quote every column name
      -- from the centrally maintained profile before generating the GRANT statement.
      IF profile_grant.columns IS NULL THEN
        EXECUTE format(
          'GRANT %s ON TABLE %I TO %I',
          array_to_string(profile_grant.privileges, ', '),
          created_table_name,
          profile_grant.role_name
        );
      ELSE
        SELECT string_agg(quote_ident(column_name), ', ' ORDER BY column_name)
        INTO grant_columns
        FROM unnest(profile_grant.columns) AS column_name;
        EXECUTE format(
          'GRANT %s (%s) ON TABLE %I TO %I',
          array_to_string(profile_grant.privileges, ', '),
          grant_columns,
          created_table_name,
          profile_grant.role_name
        );
      END IF;
    END LOOP;

    -- Mark active only after RLS/policies (when applicable) and all profile grants were installed.
    UPDATE approvio_security_table_registry
    SET status = 'active'
    WHERE table_name = created_table_name;
  END LOOP;
END
$$;

-- The registry and profile definitions are security metadata, not runtime data. Runtime code should
-- have no direct ability to change a declaration or grant; the SECURITY DEFINER trigger owns setup.
REVOKE ALL ON TABLE approvio_security_table_registry,
  approvio_security_capability_profiles,
  approvio_security_profile_grants,
  approvio_security_profile_policies
  FROM PUBLIC;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

-- Runtime capability roles need schema lookup rights for the tables granted to them. This does not
-- grant table access by itself; table privileges still come only from the capability profiles.
GRANT USAGE ON SCHEMA public TO approvio_tenant_runtime, approvio_identity_runtime,
  approvio_session_runtime, approvio_discovery_runtime, approvio_provisioning_runtime,
  approvio_scheduler_runtime, approvio_worker_runtime, approvio_audit_runtime,
  approvio_metering_runtime, approvio_security_runtime;

CREATE EVENT TRIGGER approvio_apply_security_to_created_tables
  ON ddl_command_end
  -- Run after table creation, when catalog metadata (including organization_id nullability) is visible.
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS')
  EXECUTE FUNCTION approvio_apply_security_to_created_tables();
