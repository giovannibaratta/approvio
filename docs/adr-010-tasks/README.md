# ADR 010 implementation plan

Baseline: backend commit `37f38f3`, inspected 2026-09-06. Canonical requirement: [ADR 010](../ADR/010-multi-organization-tenancy.md). These are local planning artifacts; no implementation, package publication, or commit is part of this planning task.

Read [low-level design](LOW-LEVEL-DESIGN.md), then the assigned wave and task. The design contains **proposed implementation decisions**, not claims that ADR 010 already chose them. Wave A freezes these contracts before implementation. Preserve the ADR's mandatory isolation boundaries if a proposed detail changes.

For current implementation and barrier state, read [CURRENT-STATUS.md](CURRENT-STATUS.md).
Use [LEFT.md](LEFT.md) as the active, evidence-backed completion ledger. [PENDING.md](PENDING.md)
retains earlier pickup notes and should be reconciled into the ledger before closing any task.

A1 is complete: read the [frozen contracts](contracts.md), [source inventory](inventory.md), and [A1 handoff](handoff-A1.md) before wave B. The original baseline above is retained for provenance; the handoff records current repository SHAs and selected decisions.

## Scope and readiness

A task file is a work-package boundary, not permission for adjacent cleanup. Before coding, its assignee must record the exact upstream integration SHAs and local package artifacts it consumes, expand its owned paths into a concrete file inventory, and map every acceptance item to a command or review check. The task is not ready if an earlier-wave handoff, contract signature, route/schema shape or artifact version is missing. Resolve that at the wave barrier; do not infer the previous task's intended implementation.

Prefer the smallest change that establishes ADR 010's required tenant boundary. Do not combine this work with renames, formatting sweeps, framework upgrades, generic repository abstractions or unrelated test modernization. Compatibility aliases and dual implicit/explicit organization paths are also excluded: they increase the security surface and the ADR explicitly permits a coordinated breaking cutover. Generated API/Prisma output and necessary fixture changes are expected exceptions to the small-diff rule.

## Execution order

| Wave | Result | Tasks |
| --- | --- | --- |
| [A](wave-A.md) | Freeze shared contracts and decision register | A1 |
| [B](wave-B.md) | Database schema, domain/ports, API contract | B1–B3 |
| [C](wave-C.md) | Contextual transactions, encryption, SDK | C1–C3 |
| [D](wave-D.md) | Tenant-aware repository implementations | D1–D4 |
| [E](wave-E.md) | Authentication, lifecycle, business APIs, workers, governance | E1–E6 |
| [F](wave-F.md) | Frontend, CLI, backend acceptance, deployment/docs | F1–F4 |
| [G](wave-G.md) | Integrated release rehearsal and final verification | G1 |

**Barrier rule:** Every task in a wave depends on completion and integration of **all tasks in every earlier wave**. There are no dependencies between tasks in the same wave. Same-wave code consumes frozen interfaces from earlier waves; use typed fakes in isolated tests when the implementation belongs to a peer task. Do not call a peer's unfinished implementation to pass your task gate.

At each barrier, create a versioned integration manifest containing repository SHAs, schema version, API artifact, SDK artifact where applicable, verification results and known deviations. The next wave branches only from those recorded checkpoints. A green task branch without a green wave integration gate is not a completed predecessor.

Parallelism means separate feature branches/worktrees and assigned file ownership. The wave coordinator merges task results and handles shared composition roots, barrel exports, dependency pins, lockfiles, and conflicts at the barrier. These integration edits are part of the wave gate, not hidden prerequisites for another task in that wave. Never commit on main.

Intermediate schema/type changes can break untouched callers until wave E; do not deploy these waves. Each wave has scoped gates. By the end of E, both backend and worker must compile and relevant integrated tests must pass. G is the launch gate.

## Model assignment

Model choice reflects security impact, cross-layer reasoning and expected task breadth. `gpt-6-astra` is reserved for isolation-, identity-, concurrency- and release-critical work; `gpt-5.6-sol` for substantial bounded implementation; `gpt-5.6-terra` for a well-specified client adaptation. No current work package is safe to assign end-to-end to `gpt-5.6-luna`; use Luna only for bounded inventories, mechanical fixture updates or test-result summarization under the owning task's stronger-model review. Escalate Terra/Sol work to Astra when the frozen contract is incomplete or the implementation exposes a new security decision.

| Task | Suggested model | Reason |
| --- | --- | --- |
| A1 | `gpt-6-astra` | Freezes every cross-repository security and compatibility decision. |
| B1 | `gpt-6-astra` | Destructive schema change, composite integrity, RLS and database roles. |
| B2 | `gpt-6-astra` | Defines the domain boundary and ports used by all later work. |
| B3 | `gpt-5.6-sol` | Broad but bounded OpenAPI, validator and generation work against A1. |
| C1 | `gpt-6-astra` | Transaction propagation, retries and tenant isolation are launch-critical. |
| C2 | `gpt-6-astra` | Cryptographic tenant binding and substitution resistance. |
| C3 | `gpt-5.6-sol` | Cross-client auth behavior with a frozen generated API contract. |
| D1 | `gpt-6-astra` | Account/local-user IAM and credential persistence. |
| D2 | `gpt-5.6-sol` | Bounded resource repository conversion with explicit tenant FKs. |
| D3 | `gpt-6-astra` | Workflow history, outbox, leases and duplicate suppression. |
| D4 | `gpt-6-astra` | Quota/metering concurrency and immutable audit attribution. |
| E1 | `gpt-6-astra` | Authentication, session CAS and current-authority enforcement. |
| E2 | `gpt-6-astra` | Ownership/lifecycle races and recovery authority. |
| E3 | `gpt-5.6-sol` | Large controller/service migration bounded by frozen ports. |
| E4 | `gpt-6-astra` | Vote authorization point, concurrency and durable transitions. |
| E5 | `gpt-6-astra` | Distributed worker failure modes and external side effects. |
| E6 | `gpt-6-astra` | Admission correctness, metering reconciliation and audit scope. |
| F1 | `gpt-5.6-sol` | Cross-tab/session UX and cache isolation require careful frontend work. |
| F2 | `gpt-5.6-terra` | Bounded CLI adaptation after the SDK contract is stable. |
| F3 | `gpt-6-astra` | Adversarial, cross-layer proof of the tenant boundary. |
| F4 | `gpt-5.6-sol` | Operational scripts and coordinated documentation with explicit guards. |
| G1 | `gpt-6-astra` | Final cross-repository cutover and release-safety judgment. |

The wave coordinator should use Astra for B through G even when every contained task uses a lower-tier model, because barrier review must detect contract drift across independently implemented slices.

## Integration and delivery strategy

Choose PR size by the repository's executable gate. A change may use a small GitHub PR only when that repository's normal build and relevant integration tests remain green after the merge. The backend does not meet that condition during B through D: schema/domain/API shapes intentionally break untouched callers until E. Do not add temporary compatibility code merely to manufacture green intermediate PRs.

Use this release shape:

1. Complete A1 locally and freeze repository baselines and the full contract.
2. Implement B3 as a standalone `approvio-api` branch and PR. It may merge first because consumers pin exact package versions and do not change until explicitly bumped. After that PR is green, a human may publish the new API package version. Record its version and source SHA in the integration manifest.
3. If the API package is not published, consume B3 through a local link or immutable local tarball and record its source SHA. Never mix a registry version and unrecorded mutable generated output in the same wave.
4. Keep backend B1 through E6 on a local ADR-010 integration branch, using small local task commits/worktrees and wave checkpoints for review and rollback. Run the scoped task/wave gates, but do not claim the normal backend suite is green before the E integration gate.
5. Once E is integrated and both backend and worker build with their relevant real-adapter integration tests, push that branch and open one backend PR. The task commits remain individually reviewable inside the PR. Do not merge it until F/G prove the compatible client and operational release set.
6. The SDK may use its own PR once it builds and tests against the fixed B3 artifact. Frontend and CLI may use separate PRs after the SDK/backend contract is stable and their normal tests are green. G1 pins all resulting SHAs and package versions.

Because Git cannot atomically merge multiple repositories, merge/publish under one release checklist: API contract, SDK, backend/worker, then frontend/CLI. A source merge is not a deployment signal; deployment remains quiesced until every compatible artifact in the manifest is available. Rollback is coordinated across code, schema, credentials and queue namespace; there is no supported partial rollback to an old client or pre-tenancy schema.

## Agent handoff

Each task specifies scope, concrete implementation, exclusions, and acceptance checks. On completion record changed files, actual commands/results, deviations, and remaining blockers in the task file or handoff. No task is complete with an undocumented TODO in its acceptance criteria.

Use repository-local skills and AGENTS.md in each checkout. Backend: pure domain rules; service orchestration and ports; external adapters; thin controllers; fp-ts TaskEither; no `any` or unsafe casts. Liquibase owns schema changes; generate Prisma through introspection. Follow the local test style (NestApplication, no /v1 in integration paths, no conditional expectations).

Existing untracked `docs/adr-009-tasks/`, `docs/ADR/reviews/experiments/`, and `native-evaluators-requirements.md` are unrelated user work. Do not modify them.

## Requirement coverage

| ADR 010 requirement | Implementation owners | Final evidence |
| --- | --- | --- |
| Organization ownership, names and tenant references (§2) | B1/B2, D1–D4, E2–E4 | F3, G1 |
| RLS, composite FKs, contextual queries and retries (§3) | B1, C1, D1–D4 | F3 restricted-role/race suite |
| Account/local-user split, providers, agents, owners (§4) | B2/B3, D1, E1/E2 | F3, F1/F2, G1 |
| Qualified routes, current authority and stale tabs (§5) | B3, C3, E1–E6, F1/F2 | F3, G1 browser/CLI flows |
| Onboarding, removal, suspension, deletion blocking (§6) | D1/D3, E2/E4/E5, F4 | F3, G1 restart/lifecycle flows |
| Durable jobs, quotas, metering and tenant audit (§7) | D3/D4, E4–E6 | F3, G1 failure/fairness checks |
| Encryption, egress and operator access boundary (§8) | C2, D2/D3, E5, F4 | F3 substitution/egress checks, G1 |
| Placement-independent IDs and logical IAM boundary (§9) | B1/B2/B3, C1/C3 | A1 architecture review, G1 |
| Client/migration rollout and earlier ADR alignment (§10) | B1/B3, C3, F1/F2/F4 | G1 coordinated rehearsal |

Cells, enterprise SSO, support-grant tooling and physical purge remain explicitly deferred below. F3 expands this matrix into concrete test names/results; G1 checks no mandatory launch row lacks evidence.

## Verification and rollout

Backend commands verified in package.json: `yarn ai:test <test-path> --runInBand`, `yarn build`, `yarn lint` (auto-fixes; review its diff). Test setup starts dependencies and applies migrations; use an isolated test database. Discover other repositories' scripts from their package.json. Run targeted suites per task; complete cross-repository gates in G.

Use coordinated pre-production cutover; old tokens, jobs, clients, and schema are incompatible. Do not silently assign legacy rows to a default tenant. B1 defines an empty-database migration path and a safe refusal for populated installations; F4/G document and rehearse explicit disposable-environment reset. Never reset an existing environment merely because the ADR permits breaking changes.

## Deferred scope

Customer-specific enterprise SSO and account linking; cells, routing and migration between cells; dedicated databases; BYOK/key hierarchy redesign; support-grant tooling; paid billing/grace-period automation; timed physical purging and backup erasure automation. Initial delivery must still preserve trust-scope extensibility, tenant-bound encryption, reasoned suspension, deletion tombstones, attribution, safe operational access, and organization fairness.

Physical purge has no invented retention duration and must remain disabled until a separate retention policy is defined. Suspension/deletion admission and credential/execution blocking are included now.
