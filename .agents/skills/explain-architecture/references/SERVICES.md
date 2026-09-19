# Services Layer

The Services layer orchestrates business processes and coordinates the Domain and External layers.

## Responsibility

- Orchestrate domain logic execution.
- Manage interaction with external systems (Database, Email, etc.) via interfaces.
- Define cross-domain workflows.

## Directory

`app/services/src/`

## Key Files

- `*.service.ts`: Service implementations.
- `interfaces.ts`: Repository interfaces and service-specific type definitions.

## Architectural Constraints

- **FP Patterns**: Use `fp-ts` patterns (`TaskEither`, `pipe`, `chainW`).
- **Dependency Injection**: Dependencies (like repositories) must be injected via constructor tokens to allow for easy mocking in tests.
- **No Direct DB Access**: Always use repository interfaces defined in the service layer (Dependency Inversion).
- **Error Propagation**: Define service-specific error unions and propagate errors through `TaskEither`.
- **Transactions**: While complex transactional logic is initiated here, the actual transaction implementation details remain in the External layer.
