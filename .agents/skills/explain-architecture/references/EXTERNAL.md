# External Layer (Persistence & Integrations)

The External layer contains the implementation details for database access and 3rd party integrations.

## Responsibility

- Implement Repository interfaces using Prisma.
- Handle communication with external APIs (Email, OIDC, etc.).
- Resource-specific error mapping (e.g., Prisma error -> Domain error).

## Directory

`app/external/src/`

## Key Files

- `database/*.repository.ts`: Repository implementations.
- `provider/*.provider.ts`: 3rd party service providers.

## Architectural Constraints

- **No Business Logic**: Focus strictly on data persistence or communication.
- **Port/Adapter Pattern**: This layer acts as an "Adapter" for the "Ports" (interfaces) defined in the Service layer.
- **Atomic Operations**: Implement database transactions within the repository for multi-step updates.
- **Mapping**: Data models from this layer (Prisma models) should be mapped to Domain entities before returning them to Services.
