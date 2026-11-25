# Database principals

Provision these PostgreSQL login roles outside this repository, before applying Liquibase. Use a secret manager,
managed-identity integration, or the database provider's normal role-provisioning mechanism. This is deployment
configuration, not application schema.

| Login role          | Process connection                      | Runtime capabilities granted by Liquibase                                                                              |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `approvio_tenant`   | Tenant API requests                     | `approvio_tenant_runtime`                                                                                              |
| `approvio_platform` | Login, session, discovery, provisioning | `approvio_identity_runtime`, `approvio_session_runtime`, `approvio_discovery_runtime`, `approvio_provisioning_runtime` |
| `approvio_worker`   | Workers, audit, metering, scheduler     | `approvio_worker_runtime`, `approvio_audit_runtime`, `approvio_metering_runtime`, `approvio_scheduler_runtime`         |

Each role must be `LOGIN`, non-superuser, non-owner, unable to create databases or roles, unable to bypass RLS, and
must not inherit capabilities implicitly. Configure its password, certificate, IAM token, or managed identity outside
Liquibase. Rotate that credential through the same provider mechanism; role names and grants do not change.

Liquibase uses a separate migration principal. It creates the non-login `approvio_*_runtime` roles and fails if one
already exists. It then grants them to the three principals above. Provisioning must therefore precede migration.

For disposable local databases only, run `yarn db:provision-local-logins` (development) or
`yarn db:provision-local-test-logins` (tests). Those helpers create missing login roles with local passwords and do
not grant capabilities; Liquibase supplies the memberships.
