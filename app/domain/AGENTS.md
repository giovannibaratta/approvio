## Domain Layer

Defines core business entities, value objects, and domain-specific logic for the Approval process system.

### Responsibilities

- Encapsulate business rules and domain logic
- Define value objects and entity structures
- Provide validation for domain invariants
- Expose factory methods for entity creation
- Maintain immutability through readonly types

### Patterns & Conventions

#### Entity Structure

- Use readonly types and interfaces for immutability
- Separate public types from private implementation details
- Export factory classes for creation and validation
- Use `Either` types for validation results

#### Validation

- Define specific error types using `PrefixUnion` pattern
- Use factory methods for validation logic
- Return `Either<ValidationError, Entity>` from factory methods
- Validate individual properties before entity creation

#### Constants

- Define length limits and constraints as exported constants
- Use ALL_CAPS naming for constants

#### Enums

- Use string enums for domain concepts
- Provide clear semantic meaning for each value

### Content

- `app/domain/src/**/*.ts`: Business entities, value objects, and domain logic
- `app/domain/test/**/*.test.ts`: Unit tests for domain validation and business rules

### Example Pattern

```typescript
export const ENTITY_NAME_MAX_LENGTH = 255

export enum EntityStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE"
}

export type Entity = Readonly<EntityData>

interface EntityData {
  id: string
  name: string
  status: EntityStatus
  createdAt: Date
}

type ValidationError = PrefixUnion<"entity", "name_empty" | "invalid_uuid">

export class EntityFactory {
  static validate(data: EntityData): Either<ValidationError, Entity> {
    // validation logic
  }
}
```
