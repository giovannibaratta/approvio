# Worker Layer (Background Jobs)

The Worker layer handles asynchronous job execution and event processing.

## Responsibility

- Process background jobs (e.g., sending emails, processing webhooks).
- Handle event-driven logic that shouldn't block the main API request.

## Directory

`app/worker/src/`

## Architectural Constraints

- **Idempotency**: All worker jobs must be designed to be idempotent and resilient to retries.
- **Independence**: Workers should use the same Service/Domain logic as the API, but operate in a separate process.
- **Fail-safe**: Properly handle and log errors to avoid blocking the queue processor.
