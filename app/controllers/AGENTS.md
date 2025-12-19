## Controllers

Handles incoming HTTP requests, delegates to services, and maps data for responses.

- Controller imports and user services to perform the required actions.
- Controller should validate the structure of the request and validate that the format and the values are aligned to the OpenApi specs (approvio-api)
- Controller should NOT validate that the content of the request is semantically correct

### Guidelines

- Do not use `default` branches in switch statement, use type exhaustion instead.

### Content

- `app/controllers/src/**/*controller.ts`: Implement the routes (endpoints) for the HTTP server
- `app/controllers/src/**/*mappers.ts`: Map API requests to domain entity, map domain entities to API responses
