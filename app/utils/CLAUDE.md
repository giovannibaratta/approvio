## Utils Layer

Contains shared utility functions, type definitions, validation helpers, and common patterns used across the application.

### Responsibilities

- Provide reusable validation functions (email, UUID, etc.)
- Define advanced TypeScript utility types
- Implement type guards and runtime type checking
- Support functional programming patterns (Either, Option)
- Provide date manipulation and formatting utilities

### Patterns & Conventions

#### Validation Functions

- Use descriptive function names (e.g., `isEmail`, `isUUIDv4`)
- Keep validation functions pure and side-effect free

#### Type Utilities

- Use advanced TypeScript features for type manipulation
- Provide union type helpers (`PrefixUnion`, `DistributiveOmit`)
- Support dynamic entity decoration patterns
- Create extraction utilities for complex type inference

#### Type Guards

- Implement runtime type checking with type guards
- Use `hasOwnProperty` for safe property access
- Return type predicates for TypeScript narrowing
- Support generic type guard patterns

#### Functional Programming

- Export Either/Option utilities from fp-ts
- Provide TaskEither type extraction helpers
- Support functional composition patterns

### Content

- `app/utils/src/validation.ts`: Runtime validation functions (email, UUID, etc.)
- `app/utils/src/types.ts`: Advanced TypeScript utility types and type guards
- `app/utils/src/either.ts`: Functional programming utilities (Either/Option)
- `app/utils/src/date.ts`: Date manipulation and formatting
- `app/utils/src/enum.ts`: Enum utilities and helpers
