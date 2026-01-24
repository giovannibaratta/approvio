---
name: test-runner
description: Executes the project test suite using yarn. Use this skill when the user asks to run tests, check code integrity, or verify specific files.
---

# Test Runner Skill

This skill executes the test suite for the codebase.

## When to use this skill

- When the user asks to "run tests", "check my code", or "verify changes".
- When the user specifically asks to test a file (e.g., "test the auth service").
- After refactoring code to ensure no regressions were introduced.

## Instructions

1.  **Environment Check**:
    - specific checks: Ensure `node_modules` exists. If not, run `yarn install` first.

2.  **Determine Scope**:
    - If the user provided a specific file or feature name (e.g., "test login"), append that filename or pattern to the command.
    - If the user request is generic (e.g., "run all tests"), execute the base command.

3.  **Execution**:
    - Run the command: `yarn test <optional-arguments>` in the terminal.

4.  **Analysis**:
    - Read the terminal output.
    - **If tests pass**: Confirm success to the user briefly.
    - **If tests fail**:
      - List the specific test cases that failed.
      - Analyze the error message and stack trace.
      - Remove unnecessary details from the output that would bloat the context window.
      - Suggest a potential fix for the failure if the cause is obvious.

## Constraints

- Do NOT run tests in "watch" mode.
- Do NOT attempt to fix code automatically. Just report the errors first.

## Examples

**User:** "Run the tests"
**Action:** `yarn test`

**User:** "Test the user controller"
**Action:** `yarn test user.controller.spec.ts` (or similar matching file)
