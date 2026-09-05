# Maintenance and Operational Levers

Approvio supports dynamic operational levers (feature flags) that allow system administrators to control system-wide behavior in real-time, without requiring service restarts.

These levers are evaluated locally in memory using the OpenFeature SDK connected to the Unleash provider.

## Read-Only Mode (`read_only_mode`)

The `read_only_mode` lever provides a global write protection mechanism. When enabled, it blocks any state-modifying HTTP requests across the entire application API.

### Behavior

- **Blocked Requests:** Any incoming HTTP request with a method of `POST`, `PUT`, `PATCH`, or `DELETE` is immediately intercepted by the LeverMiddleware.
- **Response:** The system returns an `HTTP 403 Forbidden` status code with an appropriate error message indicating that the system is currently in read-only mode.
- **Allowed Requests:** All `GET` and `OPTIONS` requests continue to function normally.

### Use Cases

This lever is particularly useful for operational and administrative scenarios, including:

- **Database Maintenance:** Ensuring no data is mutated during planned database migrations, backups, or scaling operations.
- **Incident Response:** Halting all state changes during an active incident while keeping data accessible for investigation.
- **System Upgrades:** Safely freezing write operations while transitioning to a new environment or executing critical deployment steps.
