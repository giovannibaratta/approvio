# Domain Layer

The Domain layer is the heart of the application, containing pure business logic and entities.

## Responsibility

- Definition of Entities, Value Objects, and Domain Types.
- Pure business logic and validation.
- State transitions.

## Directory

`app/domain/src/`

## Key Files

- `*entity.ts`: Domain models and interfaces.
- `*factory.ts`: Static factory methods for entity creation and validation.

## Architectural Constraints

- **Purity**: Must NOT have any external dependencies (no DB, no HTTP, no 3rd party APIs).
- **Immutability**: Use `readonly` types and properties.
- **Validation**: Validation must happen at construction time, typically returning `Either<ValidationError, Entity>`.
- **Logic Location**: Business rules belong in the domain, not in services or controllers.
