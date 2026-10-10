# D2: Groups, spaces and template repositories

Wave: [D](wave-D.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/database group/group-membership/space/workflow-template repositories and associated integration tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Convert every lookup/list/count/bulk/nested mutation to explicit contextual selectors. Scope workflow-template name and version allocation to the organization, while retaining immutable revision UUIDs. Composite joins cover users/agents/groups/spaces/templates. Integrate C2 encryption while keeping KMS outside DB retry closures: prepare encrypted writes before DB transaction and decrypt read results afterward. Expose transactional persistence operations consumed by quota-checked creates and grant updates. Map unique/FK errors without leaking another tenant's values.

There is no template-family adapter: the frozen domain and schema contract keeps each workflow-template revision's UUID as its immutable identity and defines no separate family entity.

## Acceptance

Same names coexist across orgs; same-org duplicate rules hold. A cannot resolve B by id/name/version/include/connect/connectOrCreate/bulk update. Version races allocate unique versions with retry. Cross-org group links fail via direct SQL and repositories. Encrypted template version copy uses target binding.

## Boundaries

No hierarchy/service authorization or controllers (E3); do not modify shared account/agent repositories or workflow/task repositories.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
