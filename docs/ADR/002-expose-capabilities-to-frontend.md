# ADR: Best-Effort Mechanism for Frontend Permission Context

**Date:** 2026-04-01
**Status:** Accepted
**Context / Scope:** Frontend (SPA) & Backend (Node.js/TypeScript) APIs

## 1. Context and Problem Statement

Our application architecture consists of a Node.js/TypeScript backend and a Single Page Application (SPA) frontend, alongside other clients like a CLI. Authentication is handled via a secure, `httpOnly` cookie for the web, and API tokens for the CLI.

The backend acts as the absolute single source of truth for all authorization. However, the SPA needs to provide a seamless User Experience (UX) by conditionally adapting UI controls (e.g., disabling a button with a tooltip, or hiding it entirely) based on the user's permissions and the resource state.

We need a standardized mechanism to communicate these permissions from the backend to the frontend. Crucially, this mechanism must:
1. Provide the "Why" (a reason for denial) to drive tooltips.
2. **Not** couple the backend to UI rendering logic (the backend should not dictate if a UI component is "hidden" or "disabled").
3. Be **opt-in**, so headless clients like the CLI don't pay the performance penalty of computing UX metadata.
4. Be **best-effort**, allowing the backend to skip this computation entirely during incidents or high server load to conserve resources.

## 2. Considered Options

We evaluated several strategies for exposing permissions to the frontend:

### Option 1: Dual Cookie (Non-sensitive Cookie + `httpOnly` Auth Cookie)
Exposing a secondary, JS-readable cookie containing a list of roles.
* **Cons:** Highly susceptible to staleness; difficult to encode complex, instance-level permissions; cannot cleanly deliver "denial reasons" for tooltips.

### Option 2: `OPTIONS`-based Probing
Sending an HTTP `OPTIONS` request to an endpoint to discover allowed methods.
* **Cons:** Extremely chatty (N+1 problem); lacks granularity; cannot return contextual reasons for *why* an action is denied.

### Option 3: Mandatory Capabilities in API Payloads
Attaching capability metadata to every API response.
* **Cons:** Forces headless clients (CLI, third-party API integrations) to wait for expensive policy evaluations they will just ignore. 

### Option 4: Opt-In, Best-Effort Rich Capabilities (Chosen)
Allowing clients to explicitly request capability metadata via a flag, providing `allowed` booleans and `reason` strings, while treating the computation as strictly optional on the server side.

### Option 5: Dedicated `/permissions` Endpoints

Exposing specific endpoints to check permissions (e.g., `GET /projects/123/permissions`).

- **Pros:** Keeps main resource payloads lean; highly explicit.
- **Cons:** Introduces extra network latency; creating a list view with 50 items would require either 50 additional requests or complex batching mechanisms.

## 3. Decision

We will adopt **Option 4: Opt-In, Best-Effort Rich Capabilities**. 

The backend will evaluate business rules and policies mapped to "Domain Actions" (e.g., `edit`, `delete`, `create_task`), but *only* if requested, and *only* if server capacity allows. The backend provides the context; the frontend decides how to render it.

### 3.1 Payload Structure
The payload will inform the frontend of the permission status and the reason for denial, but leaves the visual implementation (hide vs. disable) entirely up to the frontend components.

```typescript
interface Capability {
  allowed: boolean;
  reason?: string; // Human-readable reason or i18n code for the tooltip if denied
}
```

### 3.2 Client Opt-In Mechanism
To prevent performance degradation for headless clients (like the CLI) or bulk data fetches, capabilities will **not** be computed by default. 
* The SPA must explicitly request them, for instance by appending a query parameter (e.g., `?include_capabilities=true`) or a specific HTTP header (e.g., `X-Include-Capabilities: true`).
* The CLI and third-party API consumers will simply omit this flag and receive the standard JSON payload without the `capabilities` block.

### 3.3 Best-Effort & Load Shedding (Server-Side Kill Switch)
Because this data is purely for UX enhancement and not required for application functionality, the backend treats the `include_capabilities` request as **best-effort**.
* Under normal operating conditions, the backend fulfills the request.
* Under heavy load, degraded performance, or database strain, the backend can dynamically disable capability computation globally or per-endpoint. The API will respond successfully with the domain data, but the `capabilities` block will be missing.

### 3.4 Placement Rules
When returned, capabilities will be placed contextually:
* **Instance-Level Actions (Edit, Delete):** Attached directly to the resource object in a `capabilities` property.
* **Collection-Level Actions (Create):** Attached to the root or `_meta` object of a list endpoint.
* **Global Actions:** Attached to the application bootstrap endpoint (`GET /api/me` or `/api/session`).

### 3.5 Frontend Fallback Behavior
Because the capabilities block is optional and might be dropped under load, the SPA must be designed to fail gracefully:
* If `capabilities` is `undefined`, the UI should fallback to a safe default (e.g., showing the button without a tooltip, or hiding it depending on the component's strictness).
* If a user clicks an exposed button but lacks permission, the backend's standard 403 Forbidden response will be caught by the frontend API client, displaying a standard error toast.

## 4. Consequences

### Positive
* **Decoupled Architecture:** The backend provides pure authorization context (the "what" and "why"). The frontend owns the UI logic (the "how").
* **Performance Preserved for API/CLI:** Headless clients experience zero overhead from UI-specific policy evaluations.
* **Resiliency (Load Shedding):** The server can aggressively shed non-critical workload (capability computation) during traffic spikes while keeping core API operations functional.
* **Great UX:** Web users still get contextual tooltips and disabled states during normal operations.

### Negative / Mitigations
* **Frontend Complexity:** SPA developers must write defensive code to handle cases where the `capabilities` object is missing from the payload. *Mitigation: Create a reusable `<PermissionGate>` React component that encapsulates the fallback logic.*
* **Caching:** Endpoints requested with capabilities are user-specific. *Mitigation: Standardize `Cache-Control: private` on authenticated requests and rely strictly on client-side caching (e.g., React Query) keyed by the URL + query parameters.*