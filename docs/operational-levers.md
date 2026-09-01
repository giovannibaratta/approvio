# Operational Levers

Approvio uses feature flags, also known as "operational levers," to dynamically control system behavior in real-time without requiring service restarts. These levers are implemented using OpenFeature and evaluated via an internal Unleash provider.

This document describes the available operational levers and how to configure them safely.

## Available Levers

### Global Read-Only Mode (`read_only_mode`)

This lever enables global write protection across the entire Approvio platform. When activated, all operations that modify data (POST, PUT, PATCH, DELETE requests) are blocked, effectively placing the system in read-only mode.

- **Type**: Operational / Kill-Switch
- **Use Cases**: Scheduled maintenance, emergency data freeze, or infrastructure migrations.
- **Behavior**: When enabled, modifying requests will return a `403 Forbidden` or `503 Service Unavailable` response, while `GET` requests will continue to function normally.

### Disabling Authentication Providers (`disable_auth_provider`)

This lever allows administrators to dynamically disable specific authentication providers. When a provider is disabled, it is filtered out from the `GET /auth/providers` endpoint and cannot be used for new logins.

- **Type**: Operational / Kill-Switch
- **Use Cases**: Phasing out an old Identity Provider, or temporarily disabling a compromised provider.
- **Behavior**: Requires targeting constraints to disable only specific providers.

## Unleash Configuration Guide

> [!CAUTION]
> **Do NOT enable these toggles with a 100% standard strategy unless you intend to apply them globally.** For instance, enabling `disable_auth_provider` globally will disable **all** authentication providers, locking everyone out. Always configure strategy constraints targeting specific resources when appropriate.

### Example: Disabling a Specific Auth Provider

1. **Flag Name**: `disable_auth_provider`
2. **Strategy**: Add a strategy with **Strategy Constraints**.
3. **Context Attribute**: Set `providerId` (or `targetingKey`).
4. **Constraint Operator**: `IN` or `STR_CONTAINS`.
5. **Values**: Enter the exact provider ID(s) to disable (e.g., `okta`, `auth0`).

### Example: Enabling Read-Only Mode

1. **Flag Name**: `read_only_mode`
2. **Strategy**: Add a **Standard Strategy** and set it to 100% (since this is typically a global toggle).
3. **Result**: All data-modifying endpoints will immediately begin rejecting requests.
