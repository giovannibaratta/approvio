---
name: explain-architecture
description: Explains the architectural patterns, layer responsibilities, and constraints of the Approvio backend.
---

# Architecture Explanation Skill

This skill provides a deep dive into the Approvio backend architecture. It defines the responsibilities and constraints of each layer to ensure system consistency and maintainability.

## API Request Flow

`Request -> Controllers -> Services -> Domain + External -> Response`

## Detailed Layer Documentation

Learn about each layer's specific responsibilities and architectural constraints:

- **[Controllers Layer](references/CONTROLLERS.md)**: HTTP handling and data mapping.
- **[Services Layer](references/SERVICES.md)**: Orchestration and business processes.
- **[Domain Layer](references/DOMAIN.md)**: Pure business logic and entities.
- **[External Layer](references/EXTERNAL.md)**: Database persistence and 3rd party integrations.
- **[Worker Layer](references/WORKER.md)**: Background job processing.
- **[Utils Layer](references/UTILS.md)**: Shared helper functions.

## Architectural Principles

- **Dependency Inversion**: Higher-level modules (Services) should not depend on lower-level modules (External). Both should depend on abstractions (Interfaces).
- **Functional Programming**: Heavy use of `fp-ts` for error handling and composition.
- **Clean Architecture**: Separation of concerns between external interfaces, business logic, and data persistence.
