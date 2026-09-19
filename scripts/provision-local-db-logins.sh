#! /usr/bin/env bash

set -euo pipefail

profile="${1:-dev}"

case "${profile}" in
  dev)
    service="db"
    port="5432"
    ;;
  test)
    service="integration-test-db"
    port="5433"
    ;;
  *)
    echo "Usage: $0 [dev|test]" >&2
    exit 1
    ;;
esac

tenant_password="${APPROVIO_LOCAL_TENANT_DB_PASSWORD:-Safe1!}"
platform_password="${APPROVIO_LOCAL_PLATFORM_DB_PASSWORD:-Safe1!}"
worker_password="${APPROVIO_LOCAL_WORKER_DB_PASSWORD:-Safe1!}"

# This helper is only for the disposable Compose databases. It creates login principals but
# intentionally grants no capability roles; Liquibase owns those non-secret memberships.
docker compose -f dev-external-deps/docker-compose.yaml --profile "${profile}" exec -T "${service}" \
  psql --username developer --dbname approvio --set ON_ERROR_STOP=1 \
  --set "tenant_password=${tenant_password}" \
  --set "platform_password=${platform_password}" \
  --set "worker_password=${worker_password}" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  login_name,
  login_password
)
FROM (
  VALUES
    ('approvio_tenant', :'tenant_password'),
    ('approvio_platform', :'platform_password'),
    ('approvio_worker', :'worker_password')
) AS logins(login_name, login_password)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = login_name)
\gexec
SQL
