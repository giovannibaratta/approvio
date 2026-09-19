-- Security bootstrap
--
-- This file is executed before the application tables are created. It establishes the capability roles,
-- the allowlisted security profiles, and the registry consumed by the DDL event trigger below.
--
-- Table migrations opt into this mechanism by inserting a pending registry row immediately before
-- CREATE TABLE in the same transaction. The event trigger consumes that row, applies isolation and
-- profile grants, and marks the row active. A public table created without that declaration fails.

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
GRANT approvio_worker_runtime, approvio_audit_runtime,
  approvio_metering_runtime, approvio_scheduler_runtime TO approvio_worker;
GRANT approvio_security_runtime TO approvio_platform;

-- One row per application table is the declaration consumed by the DDL trigger.
-- security_class determines the row-isolation policy; capability_profile determines table privileges.
-- status is a small lifecycle: pending before CREATE TABLE, applying while the trigger configures it,
-- active only after policies and grants have been installed.
CREATE TABLE approvio_security_table_registry (
  table_name text PRIMARY KEY,
  security_class text NOT NULL CHECK (security_class IN ('tenant', 'tenant_with_discovery', 'organization', 'platform')),
  capability_profile text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'active'))
);

-- Profiles and their grants are owned centrally by this bootstrap. Table migrations may choose a
-- named profile, but cannot define new roles or privilege combinations alongside an individual table.
CREATE TABLE approvio_security_capability_profiles (
  profile_name text PRIMARY KEY
);

CREATE TABLE approvio_security_profile_grants (
  profile_name text NOT NULL REFERENCES approvio_security_capability_profiles(profile_name),
  role_name text NOT NULL,
  privileges text[] NOT NULL,
  columns text[],
  PRIMARY KEY (profile_name, role_name)
);

-- Profile names accepted by table migrations. Compatibility with security_class is enforced by the
-- trigger below, so a table cannot combine tenant isolation with a platform-only profile, for example.
INSERT INTO approvio_security_capability_profiles(profile_name)
VALUES
  ('organization'),
  ('platform_accounts'),
  ('platform_provider_connections'),
  ('platform_account_identities'),
  ('platform_sessions'),
  ('platform_security_events'),
  ('tenant_crud'),
  ('tenant_with_discovery'),
  ('tenant_outbox'),
  ('tenant_worker'),
  ('tenant_usage'),
  ('tenant_usage_events'),
  ('tenant_audit'),
  ('tenant_event_receipts'),
  ('platform_none');

-- Each row grants the listed SQL privileges to one capability role for one profile.
-- NULL columns means the grant applies to the whole table; a column array narrows the grant to those
-- columns. Keep profiles operation-based and least-privilege: tables with different repository needs
-- should use different profiles rather than broadening a shared profile for one special case.
INSERT INTO approvio_security_profile_grants(profile_name, role_name, privileges, columns)
VALUES
  -- Organization records use tenant-scoped reads/updates, broad discovery/scheduler reads, and
  -- a provisioning-only insert path for organization creation.
  ('organization', 'approvio_tenant_runtime', ARRAY['SELECT', 'UPDATE'], NULL),
  ('organization', 'approvio_discovery_runtime', ARRAY['SELECT'], NULL),
  ('organization', 'approvio_scheduler_runtime', ARRAY['SELECT'], NULL),
  ('organization', 'approvio_provisioning_runtime', ARRAY['INSERT'], NULL),
  -- Platform identity and session data are split by purpose. Session code can read accounts, while
  -- identity code owns account writes; sessions and provider connections have narrower profiles.
  ('platform_accounts', 'approvio_identity_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('platform_accounts', 'approvio_session_runtime', ARRAY['SELECT'], NULL),
  ('platform_provider_connections', 'approvio_identity_runtime', ARRAY['SELECT'], NULL),
  ('platform_provider_connections', 'approvio_session_runtime', ARRAY['SELECT'], NULL),
  ('platform_account_identities', 'approvio_identity_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE'], NULL),
  ('platform_sessions', 'approvio_session_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
  ('platform_security_events', 'approvio_security_runtime', ARRAY['INSERT'], NULL),
  -- Tenant tables use row-level isolation; discovery access, when needed, is column-limited.
  ('tenant_crud', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'], NULL),
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
  -- Receipts and audit history are append-only for their writers; these profiles intentionally
  -- withhold UPDATE and DELETE. Metering has access only to the usage operations it performs.
  ('tenant_event_receipts', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_event_receipts', 'approvio_worker_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_audit', 'approvio_tenant_runtime', ARRAY['SELECT', 'INSERT'], NULL),
  ('tenant_audit', 'approvio_audit_runtime', ARRAY['SELECT', 'INSERT'], NULL);

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
  created_table_name text;
  -- Roles named by the profile and used by the tenant isolation policy.
  policy_roles text;
  -- Validation and SQL-formatting scratch values.
  organization_column_exists boolean;
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
         'approvio_security_profile_grants'
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

    -- Enforce the class/profile allowlist. Class selects the isolation model; profile selects exact
    -- capability grants. This prevents, for example, assigning platform_accounts to a tenant table.
    IF NOT (
      (registration.security_class = 'tenant' AND registration.capability_profile IN (
        'tenant_crud', 'tenant_outbox', 'tenant_worker', 'tenant_usage',
        'tenant_usage_events', 'tenant_audit', 'tenant_event_receipts'
      ))
      OR (registration.security_class = 'tenant_with_discovery' AND registration.capability_profile = 'tenant_with_discovery')
      OR (registration.security_class = 'organization' AND registration.capability_profile = 'organization')
      OR (registration.security_class = 'platform' AND registration.capability_profile IN (
        'platform_accounts', 'platform_provider_connections', 'platform_account_identities',
        'platform_sessions', 'platform_security_events', 'platform_none'
      ))
    ) THEN
      RAISE EXCEPTION 'capability profile % is not compatible with security class % for table %',
        registration.capability_profile, registration.security_class, created_table_name;
    END IF;

    -- PUBLIC receives no table privileges. Runtime access comes only from the selected profile below.
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', created_table_name);

    -- Tenant classes and the organization class receive RLS policies below. Platform-class tables
    -- intentionally have no tenant predicate; their access is controlled by the selected grants.
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
      ) INTO organization_column_exists;

      IF NOT organization_column_exists THEN
        RAISE EXCEPTION 'tenant table requires NOT NULL organization_id: %', created_table_name;
      END IF;

      -- The tenant policy applies to every role granted this profile. No profile grants means there
      -- is no capability set to bind to the policy, so treat that as a malformed tenant profile.
      SELECT string_agg(quote_ident(profile_role.role_name), ', ' ORDER BY profile_role.role_name)
      INTO policy_roles
      FROM approvio_security_profile_grants AS profile_role
      WHERE profile_role.profile_name = registration.capability_profile;

      IF policy_roles IS NULL THEN
        RAISE EXCEPTION 'tenant table requires a capability profile with grants: %', created_table_name;
      END IF;

      -- ENABLE activates RLS; FORCE also subjects the table owner to policies. The policy compares
      -- organization_id with transaction-local context. NULLIF treats an unset/empty setting as NULL,
      -- which matches no UUID and therefore exposes or accepts no tenant rows.
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', created_table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', created_table_name);
      EXECUTE format(
        'CREATE POLICY %I ON %I TO %s USING (organization_id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid)',
        created_table_name || '_tenant_isolation',
        created_table_name,
        policy_roles
      );

      IF registration.security_class = 'tenant_with_discovery' THEN
        -- Discovery is an explicit extra read path; its profile separately limits the granted columns.
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR SELECT TO approvio_discovery_runtime USING (true)',
          created_table_name || '_discovery_read',
          created_table_name
        );
      END IF;
    ELSIF registration.security_class = 'organization' THEN
      -- The organizations table is special: its primary key is the tenant identifier, and only that
      -- table receives this class. Discovery/scheduler may enumerate organizations; provisioning may
      -- create them. Tenant reads and writes still match the transaction-local organization ID.
      IF created_table_name <> 'organizations' THEN
        RAISE EXCEPTION 'organization security class is reserved for organizations: %', created_table_name;
      END IF;

      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', created_table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', created_table_name);
      EXECUTE format(
        'CREATE POLICY %I ON %I TO approvio_tenant_runtime USING (id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid) WITH CHECK (id = NULLIF(current_setting(''approvio.organization_id'', true), '''')::uuid)',
        created_table_name || '_tenant_isolation', created_table_name
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO approvio_discovery_runtime USING (true)',
        created_table_name || '_discovery_read', created_table_name
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO approvio_scheduler_runtime USING (true)',
        created_table_name || '_scheduler_read', created_table_name
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT TO approvio_provisioning_runtime WITH CHECK (true)',
        created_table_name || '_provisioning_insert', created_table_name
      );
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
  approvio_security_profile_grants
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
