## External Layer

Handles communication with external systems, primarily the database (Prisma) and configuration management.

### Responsibilities

- Implement repository interfaces defined in services layer
- Handle database operations and error mapping
- Manage configuration from environment variables
- Transform between domain models and external data structures
- Handle external service integrations (email, etc.)

### Logic Guidelines

- **Avoid business logic** - Keep this layer focused on data persistence and external communication
- **Domain/Service responsibility** - Business rules and validation belong in domain/service layers
- **Atomic operations exception** - When database transactions require atomic updates across multiple entities, some coordination logic may be pushed to this layer
- **Clear interface contracts** - Repository method names should clearly indicate responsibilities and expected results

### Patterns & Conventions

#### Repository Implementation

- Use NestJS `@Injectable()` decorator
- Implement service layer repository interfaces
- Use Prisma client for database operations
- Handle Prisma-specific errors and map to domain errors
- Use `TaskEither` for all database operations

#### Data Mapping

- Create separate mapping functions for domain ↔ external models
- Handle versioning through `Versioned<T>` wrapper types
- Validate external data before mapping to domain
- Use type-safe Prisma generated types

#### Error Handling

- Map Prisma errors to domain-specific error types
- Use utility functions for common error patterns
- Handle constraint violations and database-specific errors
- Preserve error context and logging

### Content

- `app/external/src/database/**/*repository.ts`: Database repository implementations
- `app/external/src/database/shared.ts`: Common mapping functions
- `app/external/src/database/errors.ts`: Database error utilities
- `app/external/src/config/`: Configuration management
- `app/external/src/**/*provider.ts`: Third-party service integrations

### Example Pattern

```typescript
@Injectable()
export class EntityDbRepository implements EntityRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  create(entity: Entity): TaskEither<CreateError, Entity> {
    return pipe(entity, TE.right, TE.chainW(this.persistTask()), TE.chainEitherKW(mapToDomain))
  }

  // Example of atomic operation that may contain coordination logic
  createEntityWithRelations(entity: Entity, relations: Relations[]): TaskEither<CreateError, Entity> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.prisma.$transaction(async tx => {
            const createdEntity = await tx.entity.create({data: mapFromDomain(entity)})
            await tx.relation.createMany({data: relations.map(mapRelationFromDomain)})
            return createdEntity
          }),
        this.mapError
      ),
      TE.chainEitherKW(mapToDomain)
    )
  }
}
```
