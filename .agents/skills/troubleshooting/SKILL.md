---
name: troubleshooting
description: Assists with debugging issues, analyzing logs, and running tests.
---

# Troubleshooting Skill

This skill provides guidance on how to handle specific issues.

## Core Guidance

For specific troubleshooting scenarios, refer to the following documentation:

- **[TypeScript & Exhaustiveness](references/TYPES.md)**: Handling switch exhaustiveness and casting rules.
- **[Jest & Test Execution](references/JEST.md)**: Test runners, custom matchers, and timeout limits.
- **[FP-TS Patterns](references/FP-TS.md)**: Debugging functional pipes and handling `TaskEither` results.

## Diagnosis Scripts

Use these scripts to verify system state and identify errors:

| Script                        | Description                                                                                                                                                                                                                                                      |
| :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn lint`                   | Checks for codebase linting and style issues.                                                                                                                                                                                                                    |
| `yarn build`                  | Verifies TypeScript compilation across all layers.                                                                                                                                                                                                               |
| `yarn ai:test <JEST pattern>` | Runs the tests matching the specified pattern                                                                                                                                                                                                                    |
| `yarn ai:test:all`            | Runs the full integration and unit test suite silently for AI agents. Note: Completion of the test suite can take a few minutes. During the setup phase, the command will print the current operation being done, in case of failure a full output is expected". |
