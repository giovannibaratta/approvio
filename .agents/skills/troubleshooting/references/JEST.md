# Jest & Test Execution

Guidance for running and troubleshooting tests in the Approvio environment.

## Test Timeouts

Integration tests may occasionally time out due to slow dependency startup or complex operations.

- **Action**: You may increase the timeout for a failing test if necessary.
- **Constraint**: The maximum allowed timeout is **120 seconds** per test. Do not exceed this limit.

## Custom Matchers

Approvio uses custom Jest matchers for `fp-ts` types.

- `toBeRight()` / `toBeRightOf(value)`
- `toBeLeft()` / `toBeLeftOf(value)`

Always use these matchers when testing `Either` or `TaskEither` results to improve test readability and error reporting.

When using the custom matchers, you have to import `@utils/matchers` in the test file.
