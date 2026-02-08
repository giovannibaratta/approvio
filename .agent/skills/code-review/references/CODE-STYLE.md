# General Code Style Guide

Guidelines for writing clean, maintainable, and idiomatic Approvio code.

## Core Principles

- **Conciseness**: Write code that is easy to read and understand. Avoid overly clever solutions if there is no meaningful benefit.
- **Readability**: Code structure should visually aid the reader. Use logical grouping.
- **No Redundancy**: Do not add comments explaining obvious code (e.g., `if (err) return err // return error`).
- **No Magic Numbers**: Do not use magic numbers. Use constants instead.
- **Comments**: Use comments to explain complex logic, implicit assumptions, or design decisions. Explain the "why", not the "what".
- **Mimicking**: Mimic the style of the existing code in the file you are working on.

## TypeScript & Patterns

- **FP-TS**: Use functional patterns (`TaskEither`, `Either`, `pipe`) for side effects and error handling.
- **Switch Exhaustiveness**: Use exhaustiveness checks to ensure all cases are handled. If you get stuck with complex type unions, use a `default` case and leave a `TODO` for humans.
- **Interfaces**: Place interfaces at the end of the file if they are primarily used to define implementation details of the classes in that same file.
- **Casting**: Never cast to `unknown`. Avoid `any`. Use proper types or `TODO` for humans if the types are too complex.
