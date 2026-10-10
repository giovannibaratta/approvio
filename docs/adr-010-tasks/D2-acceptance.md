# D2 adapter acceptance matrix

Updated: 2026-09-28. Backend checkout: `multi-org-support`, HEAD `0a9791f` plus the preserved uncommitted implementation. This matrix records adapter coverage; it does not close the coordinated Wave D gate.

Fixtures use privileged Prisma solely to seed or inspect the isolated databases. Repository calls execute through `DatabaseClient` transactions with `SET LOCAL ROLE approvio_tenant_runtime`. Business-failure rollback checks use `PrismaTransactionManager`, which rolls back Left values.

| Surface | Current evidence |
| --- | --- |
| Group create / initial membership / user update | Local creation and same-org duplicate rejection; atomic rollback of group, membership and user update on stale user OCC. |
| Group ID/name/name-to-ID | Scoped ID and same-name reads, same names across organizations, name-to-ID resolves the local row. |
| Group bulk IDs, user/agent joins | Mixed bulk returns only local rows; local user/agent joins succeed; foreign users and populated foreign agent membership produce no local groups. |
| Group list/count/include | Search, direct-member filters and totals remain local; foreign requestor filter returns zero; foreign group include is denied; counts of a foreign group are zero. |
| Membership add/remove | Foreign organization payloads rejected; forged local organization with foreign user ID fails its composite FK; earlier local insert rolls back. Mixed removal rolls back its first local deletion when a later reference is absent. Local agent add/read/remove succeeds. |
| Membership user/agent selectors and counts | Populated foreign data stays absent; local user/agent selectors include correct domain entities; local counts are positive and foreign-group counts are zero. |
| Membership version race | Both computations carry the same loaded group OCC; exactly one update persists and the other conflicts. |
| Space create / user update | Local success/OCC increment; foreign and forged user rejection; stale-version and duplicate-name rollback. |
| Space ID/name/bulk/list/count/delete | Same-name coexistence, local ID/name/bulk/search/totals/count success, foreign ID/deletion rejection, local deletion leaves foreign row intact. |
| Template prepare create/update/replacement | Scoped preparation, atomic replacement/copy with target-bound encryption, duplicate replacement rollback, foreign update rejection and HTTP deterministic OCC race. |
| Template ID/name/version/active/non-active | Same names/versions coexist; each selector resolves its own snapshot; foreign ID and foreign-only name/version are denied; empty non-active result is None. All four selectors materialize outside the transaction. |
| Template parent mappings and count | Local parent succeeds, foreign parent denied, mixed parent-name batch fails, local unique-name count excludes revisions and foreign-space count is zero. |
| Template nested space-name list | Same space names in two organizations still yield only local templates and local totals; foreign space creation link fails its tenant FK and creates no row. |
| Template JSON/ciphertext materialization | Domain mapping validates decrypted unknown values; malformed JSON and cross-revision ciphertext substitution fail closed. Shape validation does not establish referenced-resource ownership. |
| Raw SQL / connect / connectOrCreate | These four D2 repository implementations expose no raw query, connect, or connectOrCreate path. Their explicit FK-backed insert/update selectors are covered above; do not invent an unused parallel API to test it. |

Primary evidence files: `app/external/test/database/group.repository.integration.test.ts`, `space.repository.integration.test.ts`, `workflow-template.repository.integration.test.ts`; template HTTP race evidence in `app/main/test/integration/workflows/workflow-templates.integration.test.ts`.

## Current commands

- `yarn test:jest app/external/test/database`: 26 suites, 69 tests pass after the expanded matrix.
- `yarn test:tenant-isolation:prepared`: tenant-isolation SQL and restricted tenant/worker login assertions pass on the prepared disposable test profile. This does not prove a fresh changelog replay.
- Scoped ESLint and TypeScript checks pass for the matrix changes; contract and diff checks are recorded in the D2 handoff.

## Remaining coordinated acceptance

The fresh-database Wave D gate needs the D1-D4 outputs and B2 port/security responsibility review together. L03 replay/lease acceptance and L04 cache rebuild recovery remain open and cannot be replaced by this adapter slice. E3's JSON approval/action reference existence and organization ownership validation belongs in service mutation transactions and is tracked under L07/L09. No release or Wave D completion claim is made here.
