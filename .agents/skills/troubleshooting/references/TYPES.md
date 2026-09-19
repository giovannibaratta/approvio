# Type Troubleshooting

This document provides guidance on resolving common TypeScript issues in the Approvio codebase.

## Switch Exhaustiveness Errors

In controller error mappers or handlers, we use switch exhaustiveness checks.

- **Rule**: If you encounter a type error related to switch exhaustiveness that you cannot resolve after a few attempts, you should use a `default` section for the switch.
- **Rationale**: While we prefer exhaustiveness, it might be hard for you to understand which values are missing, and you might start trashing the context window. In this case, it is better to add a default case and let a human developer review and assist with the proper exhaustiveness later.

## Type Casting

- **Rule**: Casting to `unknown` is **never allowed**.
- **Rule**: Avoid `any` at all costs.
- **Guidance**: If you are unable to correctly figure out the type signature for a specific piece of logic, leave a `TODO` comment for the human developer instead of using unsafe casts or `any`.
