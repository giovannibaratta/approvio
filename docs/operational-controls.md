# Operational Controls

Operational controls provide system administrators with the ability to manage system-wide behavior dynamically. These controls are primarily used to handle emergencies, perform maintenance, or prevent system degradation under high load.

## Load-Shedding Levers

The system uses operational levers (feature flags) to instantly shed load or restrict specific behaviors. These levers are evaluated locally without external network dependencies, ensuring they are extremely fast and reliable.

### Global Write Protection (`read_only_mode`)

The `read_only_mode` lever is a critical fail-safe mechanism designed to enforce global write protection across the entire Approvio backend platform.

When enabled, the system instantly rejects all state-mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) at the global middleware level, returning a `503 Service Unavailable` response. This happens before any internal application logic or database queries are executed.

**Key Characteristics:**

- **Instant Activation:** Takes effect immediately upon enabling the lever.
- **Global Scope:** Applies to all endpoints across all organizations and spaces.
- **Read-Only Operations Allowed:** `GET` and `OPTIONS` requests continue to function normally, allowing users to view data and administrators to inspect the system state.

**Common Use Cases:**

- Emergency response to suspected database corruption or data integrity issues.
- Planned maintenance windows where data mutation must be strictly prevented.
- Mitigating severe system overload by shedding all write traffic.

### Configuring Levers

Operational levers like `read_only_mode` can be toggled by injecting a serialized JSON string containing the lever configuration directly into the container's environment via the `LEVERS_BOOTSTRAP_JSON` variable.

Example:

```bash
LEVERS_BOOTSTRAP_JSON='{"read_only_mode": true}'
```

The system parses this string at boot time, enabling a serverless startup path that requires no baked-in static files or build-time updates.
