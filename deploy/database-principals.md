# Database principals

Provision these PostgreSQL login roles outside this repository, before applying Liquibase. Use a secret manager,
managed-identity integration, or the database provider's normal role-provisioning mechanism. This is deployment
configuration, not application schema.

| Login role          | Process connection                            | Runtime capabilities granted by Liquibase                                                                              |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `approvio_tenant`   | Tenant API requests and organization creation | `approvio_tenant_runtime`                                                                                              |
| `approvio_platform` | Login, session, discovery                     | `approvio_identity_runtime`, `approvio_session_runtime`, `approvio_discovery_runtime`, `approvio_provisioning_runtime` |
| `approvio_worker`   | Workers, audit, metering, scheduler           | `approvio_worker_runtime`, `approvio_audit_runtime`, `approvio_metering_runtime`, `approvio_scheduler_runtime`         |

Each role must be `LOGIN`, non-superuser, non-owner, unable to create databases or roles, unable to bypass RLS, and
must not inherit capabilities implicitly. Configure its password, certificate, IAM token, or managed identity outside
Liquibase. Rotate that credential through the same provider mechanism; role names and grants do not change.

Liquibase uses a separate migration principal. It creates the non-login `approvio_*_runtime` roles and fails if one
already exists. It then grants them to the three principals above. Provisioning must therefore precede migration.

For disposable local databases only, run `yarn db:provision-local-logins` (development) or
`yarn db:provision-local-test-logins` (tests). Those helpers create missing login roles with local passwords and do
not grant capabilities; Liquibase supplies the memberships.

Tenant user search may read only `platform_accounts.id` and `platform_accounts.profile_email`.
These platform columns have no tenant row scope; user-list queries must join through
organization-scoped memberships. Other account columns and account writes remain outside the tenant capability.

## Target principal layout

Worker composition selects `approvio_worker_runtime` for the shared database client and repositories;
API composition retains `approvio_tenant_runtime`, including organization creation.
Organization INSERT uses the existing organization-context policy: the new ID must match the transaction context.
The historical provisioning role remains in migration history but has no application client. Nested worker dispatch shares the worker transaction.
Transaction reuse is role-aware: a worker client cannot borrow an ambient API transaction's privileges.
The original security registry and table migrations declare tenant-scoped workflow execution
permissions through tracked profiles: SELECT on workflows/templates/votes, UPDATE only on workflow
status/version/recalculation/time columns, and SELECT/INSERT/UPDATE on expiration schedules. It does
not grant the worker login membership in the tenant role. These permissions are installed when the
workflow tables are created.

The original security registry and usage table migrations declare tenant-scoped SELECT on usage
operations, events and settlement intents, plus UPDATE only on settlement `applied_at`. Workers cannot
create charges or change operation/settlement amounts. API and worker startup use the same minimum migration version.
Actual Bull/Redis reconciliation, duplicate settlement delivery and cross-tenant isolation are covered
under the restricted worker login; process-crash/redelivery and resume acceptance remain open.

The current backend and worker processes combine several capabilities. They cannot use one-login-per-capability until
those processes are split. The target layout has a separate `NOINHERIT` login for each runtime role. Deploy that
change with the process split, new connection URLs, startup role checks, and a migration that replaces the current
three memberships. Do not grant the new memberships to the existing combined-process credentials.
