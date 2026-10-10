# D1: Account, organization and IAM repositories

Wave: [D](wave-D.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/database user/user-identity/organization-admin/agent/challenge/refresh/PKCE repositories and new account/session/membership/invitation/directory repositories; own integration tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement B2 IAM ports through C1 capabilities. Separate provider-subject authentication lookup, account-scoped discovery and tenant-local authority. Use composite selectors and immutable org fields; local user IDs own votes/groups. Implement atomic create-org+owner+index, session CAS/rotation, explicit invitation accept/revoke, removed-member tombstones, owner-count locking and agent revocation. Store step-up receipts with tenant/org/session bindings. Replace email-linked admin persistence; preserve provider trust and no email-based linking.

## Acceptance

Repository integration tests cover A/B shared account separation, no global account enumeration, concurrent creation/invite acceptance/session switch, refresh-family reuse, last-owner race and historical voter retention. Validate current authority reads under actual runtime role; wrong-org identifiers fail without metadata leakage.

## Boundaries

No auth or organization service/controller logic (E1/E2), no group/space repositories (D2). Coordinate multi-repository atomicity through existing C1 transaction.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
