# E3: Groups, spaces, templates and hierarchy APIs

Wave: [E](wave-E.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

Group/group-membership/space/workflow-template/hierarchy/resource-resolution services and controllers; resource-focused tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Thread trusted tenant context through each public method and remove DEFAULT_ORG_ID. Qualify routes, scope parent/name resolution, and enforce name-based workflow-template role scopes inside the current organization. Validate every ID in approval-rule/action JSON, user/group/agent lists and nested template references before mutation; validate immutable parent ownership. Serialize authority mutations by org lock. For creates invoke frozen quota admission port in the same transaction as count+create; emit audit/outbox through ports. Expose workflow-template name/version semantics consistently with B3.

## Acceptance

Deletion/reference rule: under the organization lock, reject deletion of a group, space, or workflow-template revision still referenced by an active rule or retained workflow. Retire/deprecate instead where history needs the row. Validate JSON references against current state inside the mutation transaction, not only in controller parsing. Recalculation must handle later revocation/removal by current workflow rules without erasing historical attribution.

API tests using E1 principal fakes and real scoped repositories show A/B same-name success, wrong-org references rejected, nested JSON and bulk mixed-org payloads rolled back, admin powers confined to org and quota last-slot race admits only allowed creates. Context-free and old routes fail.

## Boundaries

No workflow/vote services (E4), quota service implementation (E6), or auth implementation. Scope-specific wiring/barrels are integrated by coordinator at barrier.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
