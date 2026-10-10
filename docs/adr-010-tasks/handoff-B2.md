# B2 handoff

Result: B2 is complete on `adr-010-backend-integration`. The domain and service-port boundary is organization-qualified and passes its isolated gates. This remains an intermediate breaking branch: concrete services, repositories, controllers and composition roots intentionally still target the pre-tenancy contracts and are owned by later waves.

## Domain boundary

- Added separate platform `Account` and tenant-local `User` membership models. Local users bind `organizationId` and `accountId`; membership removal clears fine-grained roles, and readmission reuses the local UUID with no inherited grants.
- Added `Organization` validation and lifecycle transitions. Authorization reads the current organization status; persistence OCC protects competing updates.
- Added owner/admin/member grant rules. Admins cannot create, demote or alter owners. Owner/admin group authority and all role assignment/matching fail closed across organizations.
- Added organization ownership and validation to groups, memberships, spaces, templates, workflows, votes, agents, agent challenges, quotas, usage, audit records and action tasks. Group mutation, vote attribution, roles and audit payloads reject cross-organization references in the domain before persistence.
- Replaced agent names as credential subjects with immutable agent UUIDs and bound challenges and refresh tokens to both agent and organization.
- Split refresh-token models into platform account/session/provider-connection tokens and tenant agent tokens. `familyId` remains only the rotation/reuse-detection family for one login session.
- Added discriminated platform-user, tenant-user and tenant-agent credentials; current tenant principals and actor snapshots; invitations; browser sessions; step-up receipts; tenant events; fenced leases; and the durable task transition state machine.
- Preserved the reviewed workflow-template identity as `(organizationId, templateName, version)` plus immutable template UUID. No template-family model or role scope was introduced.

## Service ports

- Prepended `TenantContext` to the complete existing tenant-repository inventory, including list, aggregate, bulk and per-task operations, and added tenant-boundary errors without weakening existing domain errors.
- Removed implicit/default-organization contracts and obsolete organization-admin and user-identity repository shapes. Added platform identity, session, discovery, provisioning, membership, invitation, lifecycle, step-up and operator-recovery ports.
- Split account and agent refresh-token repositories. PKCE remains platform-scoped but carries an optional immutable step-up target; one-time step-up consumption is represented by the durable tenant receipt port rather than the old generic token store.
- Added transaction, tenant/platform encryption, outbox, event receipt, dispatch admission/lease, workflow/lifecycle reconciliation, quota admission, usage-operation and tenant-audit ports.
- `BoundaryError` now describes tenant-boundary failures only. Transaction retry/isolation/storage outcomes are represented separately by `TransactionError`.
- Kept health and external email/Slack/webhook providers platform/external and therefore unqualified. Concrete implementation changes are deliberately excluded.

## Verification

- `yarn tsc --pretty false --noEmit -p app/domain/tsconfig.json`: passed.
- `yarn tsc --pretty false -p /tmp/approvio-b2-ports.json`: passed with only the owned interface files as roots, proving the new/converted ports independently of later-wave concrete implementations.
- `yarn jest app/domain/test --runInBand`: 20 suites and 245 tests passed.
- Scoped `yarn eslint` over `app/domain/src`, `app/domain/test` and all owned service interface files/directories: passed.
- `git diff --check`: passed.
- Review search found no added `any` or unsafe type assertions in the new port contracts. The only remaining `familyId` usage in the owned layer is refresh-token rotation.

The normal backend/worker build was not run as a B2 acceptance gate and is not expected to pass until the concrete callers are migrated in D/E. No commit, stash, push, package publication or database change was performed as part of B2.
