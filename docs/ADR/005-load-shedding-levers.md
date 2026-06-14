# ADR 005: Approvio Load-Shedding & Operation Levers Architecture

## Context and Problem Statement

The Approvio platform requires a reliable, manually-triggered load-shedding mechanism to temporarily disable or restrict heavy, resource-intensive operations under high system load.
When the system is degraded or saturated, we need a way to short-circuit incoming write requests or specific background operations early—hard-failing with an HTTP `503 Service Unavailable` status—without hitting the transactional database or executing complex business logic.

We must decide on:

1. **Interception Lifecycle**: Where to intercept requests within our NestJS HTTP request/response flow.
2. **Evaluation Mode**: Whether to perform local evaluation (SDK-side) or server-side evaluation (remote configuration provider API).
3. **Write-Path Decoupling**: How to toggle levers safely even when the Approvio API backend is fully saturated.
4. **Synchronization Strategy**: How updates propagate to NestJS API nodes and Worker instances.
5. **Tooling & Infrastructure**: Which tools to use for managing the configuration state.

---

## Considered Options

### 1. Interception Lifecycle

- **Option A: Express/Fastify Middleware (Outermost Boundary):** Enforcing rules at the entry point of the HTTP server. Bypasses all NestJS routing, parameter parsing, and serialization.
  - _Pros:_ Absolute highest performance. Zero database/dependency hits.
  - _Cons:_ Lacks access to NestJS route handler metadata (Reflector), meaning we cannot easily map specific route handlers to levers using elegant TypeScript decorators.
- **Option B: High-Priority NestJS Guard (Endpoint Decorator):** Using a custom decorator (e.g. `@UseLever('disable_workflow_creation')`) mapped via a global NestJS Guard.
  - _Pros:_ Highly maintainable and developer-friendly. Keeps lever logic colocated with route definitions.
  - _Cons:_ Runs slightly deeper in the NestJS context than middleware (though still before guards, pipes, and controllers). Must be explicitly ordered before auth/database guards.
- **Option C: Inline Logic Selectors:** Evaluating levers directly inside core services or domain classes to disable specific portions of the logic or switch to alternative execution behaviors.
  - _Pros:_ Extreme granularity. Allows dynamic degradation inside a single business flow (e.g., serving cached/stale data or skipping an optional optimization query) instead of hard-blocking an entire HTTP endpoint.
  - _Cons:_ Highly intrusive to code. Spreads operational concerns directly into the core service layer, increasing cognitive load, complexity, and testing requirements.

### 2. Evaluation Mode

- **Option A: Local Evaluation (SDK-side):** The application client/SDK caches the full rule definitions in local memory and evaluates levers instantly for each request without network hops. The rules are updated periodically in the background (push/pull).
  - _Pros:_ Sub-microsecond evaluation. Zero network latency in the request path. High resilience—if the configuration provider is completely dead, the application runs uninterrupted using the local cache.
  - _Cons:_ Lever toggles are eventually consistent (propagating within 30 seconds to a few minutes).
- **Option B: Server-Side Evaluation (Provider-side):** The application makes a network request or a database/Redis read on _every incoming request_ to ask the provider if a lever is active.
  - _Pros:_ Instant propagation of toggled states.
  - _Cons:_ Adds severe latency and network overhead to the critical path of _every_ request. If the configuration server or Redis is saturated or down, the entire application fails. **This defeats the fundamental goal of dependency-free load-shedding.**

### 3. Write-Path Decoupling (Activation Route)

- **Option A: Standard API Endpoint on Backend:** Operators toggle levers via a standard admin controller (e.g., `POST /v1/admin/levers`).
  - _Pros:_ Simple to implement within the main app codebase. We can probably use the existing application authentication layer to identify the operator before allowing them to flip a lever (assuming the database is still operational).
  - _Cons:_ If the backend is under heavy load (event loop lag, thread starvation, or DB connection pool exhaustion), the write request to enable the lever will hang, queue, or time out, preventing operators from activating the kill switch when they need it most. Additionally, it is harder to restrict access to this endpoint at the network layer (unless a sophisticated Ingress Controller or Web Application Firewall (WAF) is available to ensure only operators can call this administrative route as an additional security measure).
- **Option B: Decoupled Out-of-Band Control Plane (Recommended):** Lever states are modified in an external system (e.g., writing directly to Redis using a script, or via a separate, isolated control dashboard running in a different container).
  - _Pros:_ The read path of NestJS instances is completely insulated from their write path. Levers can be flipped successfully even if all Approvio API instances are 100% saturated. Generally considered superior to Option A because the risk of operational self-lockout during a saturation event is much higher than the complexity of managing a separate admin access boundary.
  - _Cons:_ Does not natively share the application's built-in OAuth/session database authentication checks. Requires its own access mechanism (e.g. CLI credential check, Redis authentication, or independent admin login).

---

## Decision

We will implement a **Decoupled Control Plane** with **Local Evaluation**, wrapped via **OpenFeature**, utilizing a **Hybrid Interception Lifecycle**, and extending the mechanism to our **Worker instances**.

Specifically, we have decided on the following design pillars:

### 1. The Gatekeeper: Hybrid Interception Lifecycle

To achieve both absolute performance for global levers and elegant code maintainability for operational levers:

- **Global Middleware (Express level):** We will implement a lightweight middleware to block broad, system-wide rules like `read_only_mode` (instantly rejecting all `POST`, `PUT`, `PATCH`, `DELETE` requests with a `503` before any NestJS processing occurs).
- **High-Priority Global Guard (`LeverGuard`):** For endpoint-specific controls, we will introduce a `@UseLever(LeverName)` decorator. The global `LeverGuard` will evaluate this using NestJS `Reflector`. We will explicitly register `LeverGuard` as the **first** global guard so it executes prior to any database-backed authorization or authentication guards.
- **Service-Level Inline Selectors (Graceful Degradation):** We remain open to using **Option C (Inline Logic Selectors)** specifically within the backend **Service layer** (but strictly keeping the core Domain/Entity layer clean and decoupled). This enables us to selectively disable optimization queries, return cached data, or execute alternative code paths within service routines under load.

### 2. Local Evaluation (No Network Hops in Request Path)

To prevent degrading request performance, the `LeverService` will perform evaluations **purely in local memory**.

- Lever checks will run in `O(1)` time without making database queries or Redis calls during request resolution.
- Propagation delays of a couple of minutes are completely acceptable for our load-shedding use case (toggling a kill switch does not need sub-second real-time sync; eventual consistency within 1–2 minutes is fully sufficient).

### 3. Decoupled Write-Path (Zero Self-Lockout)

We will treat the backend application's `LeverService` as **read-only**.

- NestJS instances will only pull/receive updates from the configuration provider.
- To toggle a lever, operators will write directly to the configuration provider. For example, using a simple CLI command (`yarn lever enable <name>`), a dedicated admin script, or an external dashboard interface. This ensures we can never lock ourselves out of toggling levers during heavy backend saturation.

### 4. Background Worker Integration

The load-shedding system will apply to our **Worker services** (e.g., Bull Queue processors, cron-driven expirations) as well:

- At the start of heavy background tasks (such as a database workflow expiration sweep or automated calculations), the job processor will consult the local `LeverService`.
- If a specific worker lever (e.g., `disable_workflow_expiration_sweep` or `disable_heavy_optimizations`) is active, the worker will gracefully skip execution or delay the job, preventing database contention.

### 5. OpenFeature Standard + Infrastructure Provider

To prevent coupling the codebase to a specific tool, we will adopt the CNCF standard **OpenFeature SDK** (`@openfeature/server-sdk`).

- Our `LeverService` will act as a thin wrapper around the OpenFeature client.
- **Infrastructure Selection (Unleash):** We will self-host a lightweight instance of **Unleash** (available as a standard, isolated Docker container).
  - _Why Unleash:_ It fits our criteria. The Unleash Server runs independently of the Approvio backend. The Unleash Node.js SDK works purely on **local evaluation** (it polls the Unleash Server in the background every 15–30 seconds and keeps rules in memory). It also supports **offline bootstrap files** so the Approvio backend can boot and run safely even if the Unleash Server container is fully offline.

#### Serverless Scale-to-Zero and Bootstrapping Compatibility

When running in a serverless environment (e.g., Google Cloud Run, AWS Fargate) where instances scale down to zero, cold-starts require immediate initialization without waiting for external API queries.

- **Stateless Environment Variable Bootstrapping:** To achieve fully stateless, sub-millisecond cold starts, the application will support bootstrapping the Unleash/OpenFeature client directly from a single environment variable: `LEVERS_BOOTSTRAP_JSON`.
- **Mechanism:** Operators can inject a serialized JSON string containing the full active lever configuration directly into the container's environment (e.g. `LEVERS_BOOTSTRAP_JSON='{"read_only_mode": true}'`). At boot time, the NestJS `LeverModule` parses this string in-memory and feeds it to the Unleash SDK as the initial bootstrap object. This provides a unified, zero-latency serverless startup path without requiring baked-in static files or build-time updates.
- **Sufficient Payload Length:** Since standard Linux environment variables and modern cloud container runtimes (such as ECS/Fargate or Cloud Run) easily support string limits from 4KB to several megabytes (which is vastly larger than our expected lever configurations), this single-variable method is highly robust and completely eliminates the need for individual environment key-value merging or static image baking.

### 6. Fail-Open (Open-Fail) Default

To ensure high system availability, **fail-open** is the primary resiliency policy.

- If the Unleash Server, local Redis, or any remote configuration provider is completely unreachable during boot or runtime, the `LeverService` will log a high-priority system warning, trigger alerts, and **fail-open**.
- In fail-open mode, all operational levers default to inactive/disabled. This guarantees that a failure in the configuration control plane will never trigger a cascading outage or block access to Approvio's primary APIs.

### 7. Disabled / Absent Provider Support

To accommodate local development, testing pipelines, or lightweight on-premise deployments where Unleash is not deployed, the application will support operating without any configuration provider:

- **Graceful Deactivation:** We will define a `LEVER_PROVIDER_ENABLED` environment variable (defaulting to `false` or derived by checking if `UNLEASH_URL` is undefined).
- **Fallback No-Op Client:** If disabled, the `LeverModule` will register a local, static **No-Op Provider** (with all levers permanently turned off). This allows developers to run the backend and execute the full test suite locally without having to set up or run an Unleash/Redis container, while ensuring the code behaves consistently.

---

## Future Extensions

- **Redis Provider Fallback:** If we ever want to eliminate the Unleash container dependency, our use of the OpenFeature abstraction allows us to swap the Unleash provider with a custom Redis-based provider.
- **Gradual Load-Shedding:** Introduce percentage-based rate shedding (e.g., dropping 20% of non-critical requests) using standard feature flagging rollout strategies.
- **Multi-Tenant / User Tiering (Tenant-Aware Load-Shedding):** In multi-tenant or multi-tier subscription models (e.g., Free, Standard, Premium), load-shedding can be applied selectively. Under high load, operational levers can be activated purely for Free or Standard tier users, reserving system resources to maintain normal operations for high-value Enterprise tenants. Since OpenFeature evaluations accept a contextual `EvaluationContext` (containing the tenant ID and subscription tier), the `LeverService` can evaluate flags dynamically based on the current user or tenant context.
