# Controllers Layer

The Controllers layer handles the HTTP communication and acts as the entry point for API requests.

## Responsibility

- Receive and validate HTTP requests against the OpenAPI specification.
- Map request data to Service/Domain models.
- Delegate workflow execution to Services.
- Map Service results (including errors) to appropriate HTTP responses/exceptions.

## Directory

`app/controllers/src/`

## Key Files

- `*.controller.ts`: NestJS controller classes.
- `*.mappers.ts`: Functions to convert between OpenAPI models and internal models.

## Architectural Constraints

- **No Business Logic**: Controllers must NOT contain any business rules.
- **Data-centric Validation**: Use validation only for request structure and format (e.g., via NestJS pipes and OpenAPI specs). Semantic validation belongs to the Domain.
- **Error Mapping**: Responsible for mapping internal `fp-ts` errors into specific HTTP status codes and response bodies.
- **Security**: Handled via NestJS guards at this level.
