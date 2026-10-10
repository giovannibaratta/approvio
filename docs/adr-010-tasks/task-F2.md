# F2: CLI organization selection and credentials

Wave: [F](wave-F.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

/workspace/approvio-cli config-manager, utils/sdk, auth/org/admin/resource commands and CLI tests.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Consume C3 SDK. Add organization list/create/select and --organization override; store selected org and credential scope per profile/account, not one implicit global workspace. Resolve selection once per command; reject credential/path mismatch before mutation. Replace global org-admin commands with explicit local owner/member operations; adapt all resources and organization-scoped workflow templates. Agent registration requires org and UUID-based credentials. Switching CLI selection does not mutate browser sessions.

## Acceptance

Config migration refuses ambiguous old implicit org state and prompts reauthentication/selection. Tests cover two profiles/orgs, explicit overrides, missing org, mismatched token, refresh/step-up, same-name resource targeting and noninteractive commands. CLI build/tests pass; help/examples show tenant-qualified behavior.

## Boundaries

No SDK/backend modifications. Do not migrate old credentials by guessing an organization.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
