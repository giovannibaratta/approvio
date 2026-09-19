# Testing Style Guide

Best practices for writing and maintaining tests in the Approvio codebase.

## Test Structure

- **Patterns**: Inside test blocks (`it`), use `Given`, `When`, `Expect` comments to structure the test logic.
- **Grouping**: Use `describe` blocks to group "success cases" and "failure cases" (bad inputs, unauthorized access, etc.).

## Assertions & Matchers

- **FP-TS Matchers**: Always use custom matchers for `fp-ts` types:
  - `toBeRight()` / `toBeRightOf(value)`
  - `toBeLeft()` / `toBeLeftOf(value)`
- **Imports**: Ensure you import `@utils/matchers` in your test file to use these matchers.
- **No Conditionals**: Avoid conditional assertions within tests.

## Strategy

- **Integration vs Unit**: Prefer integration tests to ensure system components work correctly together.
- **Mocking**: Reduce mocking to the minimum required. Prefer real implementations when possible.
- **Timeouts**: You may increase test timeouts up to **120 seconds** if necessary for slow integration tests.

## Naming

- Test names should be descriptive of the behavior being tested (e.g., `it("should return Unauthorized when no token is provided")`).
