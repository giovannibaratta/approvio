#!/usr/bin/env bash

# Verify capability access using the real PostgreSQL login principals, not the bootstrap
# `developer` account used by tenant-isolation.sql. This script expects the test Compose
# database to be running and its logins to have been provisioned by test setup.
#
# Passwords match provision-local-db-logins.sh. Override them with
# APPROVIO_LOCAL_TENANT_DB_PASSWORD and APPROVIO_LOCAL_WORKER_DB_PASSWORD when needed.
set -euo pipefail

compose=(docker compose -f dev-external-deps/docker-compose.yaml --profile test)
tenant_password="${APPROVIO_LOCAL_TENANT_DB_PASSWORD:-Safe1!}"
worker_password="${APPROVIO_LOCAL_WORKER_DB_PASSWORD:-Safe1!}"
organization_id="$(node -p 'require("node:crypto").randomUUID()')"
other_organization_id="$(node -p 'require("node:crypto").randomUUID()')"
group_id="$(node -p 'require("node:crypto").randomUUID()')"
other_group_id="$(node -p 'require("node:crypto").randomUUID()')"

# Remove only this run's rows, including when a login assertion fails midway through the script.
cleanup() {
  local exit_code=$?
  trap - EXIT
  if ! "${compose[@]}" exec -T integration-test-db \
    psql --no-psqlrc --username developer --dbname approvio --set ON_ERROR_STOP=1 \
    --set "group_id=${group_id}" --set "other_group_id=${other_group_id}" \
    --set "organization_id=${organization_id}" --set "other_organization_id=${other_organization_id}" <<'SQL'
DELETE FROM groups WHERE id IN (:'group_id'::uuid, :'other_group_id'::uuid);
DELETE FROM organizations WHERE id IN (:'organization_id'::uuid, :'other_organization_id'::uuid);
SQL
  then
    echo "Failed to remove capability-check fixtures." >&2
    exit_code=1
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# Seed committed rows in two organizations so the later connections test RLS against known data.
# The UUIDs are unique to this run; the EXIT trap removes these rows after both login checks.
"${compose[@]}" exec -T integration-test-db \
  psql --no-psqlrc --username developer --dbname approvio --set ON_ERROR_STOP=1 \
  --set "organization_id=${organization_id}" --set "other_organization_id=${other_organization_id}" \
  --set "group_id=${group_id}" --set "other_group_id=${other_group_id}" <<'SQL'
BEGIN;
INSERT INTO organizations(id, slug, display_name, plan_tier, status, occ, created_at, updated_at) VALUES
  (:'organization_id'::uuid, 'capability-check-' || :'organization_id', 'Capability Check One', 'FREE', 'active', 1, now(), now()),
  (:'other_organization_id'::uuid, 'capability-check-' || :'other_organization_id', 'Capability Check Two', 'FREE', 'active', 1, now(), now());
INSERT INTO groups(id, organization_id, name, created_at, updated_at, occ) VALUES
  (:'group_id'::uuid, :'organization_id'::uuid, 'capability-check-group-one', now(), now(), 1),
  (:'other_group_id'::uuid, :'other_organization_id'::uuid, 'capability-check-group-two', now(), now(), 1);
COMMIT;
SQL

# Connect over TCP so PostgreSQL authenticates the provisioned login with its password.
# psql stops on the first SQL error; SET LOCAL ROLE verifies this login can activate its
# intended non-login capability role for the duration of the test transaction.
"${compose[@]}" exec -T -e "PGPASSWORD=${tenant_password}" integration-test-db \
  psql --no-psqlrc --host 127.0.0.1 --username approvio_tenant --dbname approvio --set ON_ERROR_STOP=1 \
    --set "organization_id=${organization_id}" <<'SQL'
BEGIN;
SET LOCAL ROLE approvio_tenant_runtime;
DO $$
BEGIN
  -- session_user remains the authenticated login; current_user becomes the active capability role.
  IF session_user <> 'approvio_tenant' OR current_user <> 'approvio_tenant_runtime' THEN
    RAISE EXCEPTION 'tenant login did not activate approvio_tenant_runtime';
  END IF;
  -- Without transaction-local organization context, tenant RLS must hide every group.
  IF (SELECT count(*) FROM groups) <> 0 THEN
    RAISE EXCEPTION 'tenant login can see seeded groups without an organization context';
  END IF;
  -- Durable work belongs to worker processing and must not be accessible to a tenant request.
  IF has_table_privilege(current_user, 'durable_work', 'SELECT') THEN
    RAISE EXCEPTION 'tenant login has worker-only durable_work access';
  END IF;
  -- The tenant login must not be able to switch to the worker capability role.
  IF pg_has_role(session_user, 'approvio_worker_runtime', 'MEMBER') THEN
    RAISE EXCEPTION 'tenant login can assume the worker capability role';
  END IF;
END
$$;
-- A valid organization context must reveal its seeded row and keep the other tenant's row hidden.
SELECT set_config('approvio.organization_id', :'organization_id', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM groups) <> 1 THEN
    RAISE EXCEPTION 'tenant login cannot see exactly its organization group';
  END IF;
END
$$;
-- All checks are read-only; rollback also makes this safe if future checks add fixtures.
ROLLBACK;
SQL

"${compose[@]}" exec -T -e "PGPASSWORD=${worker_password}" integration-test-db \
  psql --no-psqlrc --host 127.0.0.1 --username approvio_worker --dbname approvio --set ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE approvio_worker_runtime;
DO $$
BEGIN
  -- Confirm authentication used the worker login and the expected capability role is active.
  IF session_user <> 'approvio_worker' OR current_user <> 'approvio_worker_runtime' THEN
    RAISE EXCEPTION 'worker login did not activate approvio_worker_runtime';
  END IF;
  -- These are the worker's processing operations on durable work items.
  IF NOT has_table_privilege(current_user, 'durable_work', 'SELECT')
    OR NOT has_table_privilege(current_user, 'durable_work', 'UPDATE') THEN
    RAISE EXCEPTION 'worker login is missing durable_work processing privileges';
  END IF;
  -- Worker capability must not expose tenant group data.
  IF has_table_privilege(current_user, 'groups', 'SELECT') THEN
    RAISE EXCEPTION 'worker login has tenant groups access';
  END IF;
  -- These roles are reserved for tenant requests or future dedicated audit/metering clients.
  IF pg_has_role(session_user, 'approvio_tenant_runtime', 'MEMBER')
    OR pg_has_role(session_user, 'approvio_audit_runtime', 'MEMBER')
    OR pg_has_role(session_user, 'approvio_metering_runtime', 'MEMBER') THEN
    RAISE EXCEPTION 'worker login can assume a tenant, audit, or metering capability role';
  END IF;
END
$$;
-- End the test transaction without changing any persistent database state.
ROLLBACK;
SQL

# Reaching here means both password-authenticated logins passed all privilege checks.
echo "Capability login checks passed for approvio_tenant and approvio_worker."
