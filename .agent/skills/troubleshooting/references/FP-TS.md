# FP-TS Patterns & Debugging

Guidance for working with `fp-ts` and functional programming patterns in the codebase.

## Result Interpretation

- **Left(Error)**: Indicates a business failure or validation error. Always check the specific error type to provide meaningful feedback.
- **TaskEither**: Represents an asynchronous operation that might fail. Ensure it is properly awaited and the result is handled (e.g., via `pipe(result, TE.match(...))`).

## Debugging Pipes

If a `pipe` sequence fails to compile:

1. **Check Return Types**: Verify that each function in the pipe returns a compatible type for the next function in the chain.
2. **Break it Down**: If the pipe is complex, temporarily break it into smaller variables to isolate which step is causing the type mismatch.
3. **TaskEither Chaining**: Use `TE.chainW` when types might be widened, especially for error unions.
