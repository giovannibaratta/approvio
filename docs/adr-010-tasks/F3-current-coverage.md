# Current F3 acceptance coverage

Updated 2026-10-05. Partial evidence; this matrix does not close L09. Runtime assertions use real
adapters on the owned disposable PostgreSQL instance at loopback port 55436. Administrative fixture
writes are separate from runtime-role execution. SDK/frontend are excluded.

| Requirement | Current executable evidence | Limit |
| --- | --- | --- |
| Current persisted authority and organization selection | `app/main/test/integration/auth/session-principal.integration.test.ts` | Broad endpoint-by-endpoint authority coverage remains to be inventoried. |
| Committed revocation, stale context, last owner, invitation acceptance race | `app/main/test/integration/tenancy/tenant-boundary.integration.test.ts` | Invitation race uses an observed database lock barrier; admission storage failure uses an existing injected repository error. |
| Receipt identity, duplicate receipt and consumer rollback | `app/external/test/database/event-receipt.repository.integration.test.ts` | Does not simulate a process crash. |
| Tenant-bound outbox claim and acknowledgement | `app/external/test/database/tenant-outbox.repository.integration.test.ts` | Separate relay fairness/process recovery acceptance is recorded in L06 evidence. |
| Append-only platform security records | `app/external/test/database/platform-security-event.repository.integration.test.ts` | Does not prove every platform metadata endpoint. |
| Ciphertext tenant/resource/field binding and copy substitution | `app/external/test/kms/context-bound-encryption.service.test.ts` | Cryptographic adapter acceptance, not every encrypted endpoint. |
| Dispatch capacity, ownership renewal, expired claims, unknown sending and suspension | `app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts` | Persisted expiry preconditions; actual crash/Bull stalled redelivery and bounded resume remain open. |
| JSON approval references and replacement rollback | `app/external/test/database/workflow-template.repository.integration.test.ts` and `app/main/test/integration/workflows/workflow-templates.integration.test.ts` | Mutation-time lookup; no JSON foreign key or permanent prohibition on deleting groups. |
| Restricted worker workflow/usage composition | `app/worker/test/integration/restricted-worker-composition.integration.test.ts` | Does not establish the entire worker lifecycle gate. |

## Current results

The six suites for session principal, event receipts, platform security events, tenant outbox, bound
encryption and dispatch lifecycle passed **55 tests** in one current-checkout run. With maintenance
URLs pointing to port 55436, run `yarn test:jest` followed by those six paths. The separate workflow,
tenancy and restricted-worker regression passed **8 suites / 163 tests**; template reference acceptance
passed **2 suites / 72 tests**. These overlapping counts are not additive.

## Unproven requirements

The complete tenant endpoint inventory and repository lookup/list/count/include/bulk/raw/JSON matrix
remain unfinished. Deterministic vote/quota/context/worker races need a requirement-by-requirement
mapping. Same resource names across tenants plus shared-account unequal permissions need explicit
coverage attribution. Old context-free routes and all platform metadata surfaces require enumeration.
Actual process crash/Bull redelivery and bounded resume/cancellation remain incomplete. A passing
slice, build, contract verifier or migration replay does not prove these requirements.

The full backend/worker integration directories subsequently passed 47 suites / 640 tests. This does
not prove E4's required vote/revocation serialization: `VoteService.castVote` still explicitly documents
optimistic eligibility. That requirement remains an implementation gap, not just a missing test.

Scope correction (2026-10-05): the user retains current optimistic vote authorization. Strict mid-request
revocation serialization is not a current acceptance requirement. The rejected regression has been
removed. Organization resume/reconciliation is deferred. The preceding proposed E4 gap is withdrawn.
