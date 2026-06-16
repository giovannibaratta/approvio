# ADR 008: Support for Multi-Identity Provider (Multi-IDP) User Authentication

**Date:** 2026-06-16
**Status:** Proposed
**Context / Scope:** Backend (Auth Service, OIDC, Config Provider) & Frontend (Login Page)

## 1. Context and Problem Statement

Currently, the Approvio backend supports only a single OpenID Connect (OIDC) identity provider, configured statically via individual environment variables (`OIDC_PROVIDER`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, etc.). The `ConfigProvider` exposes a single `oidcConfig: OidcProviderConfig`, and the `OidcBootstrapService` performs discovery for that one provider at startup.

As Approvio scales to support multi-tenant environments and enterprise customers, we need to allow users to authenticate via multiple Identity Providers (IDPs)—for example, Google Workspace for general sign-ins and Okta/Entra ID for enterprise single sign-on (SSO).

We need a design that resolves the following criteria:
1. **Startup Configuration:** How to define multiple OIDC providers statically at startup.
2. **Dynamic Levers:** How to dynamically disable specific providers using our feature lever system.
3. **Frontend Drift & Discovery:** How the frontend learns about available providers without configuration drift.
4. **User Deduplication & Identity Linking:** How we merge or separate users arriving from different IDPs with the same email.
5. **OpenAPI & Flow Impact:** How this impacts the web and CLI authentication endpoints.
6. **Security Implications:** Ensuring email verification constraints, preventing account takeover via spoofed IDPs, and securing redirect endpoints.

---

## 2. Considered Options & Brainstorming

### Topic A: Configuration Strategy for Multiple IDPs
To configure multiple OIDC providers, we need to replace the singular `oidcConfig` block.

*   **Option A1: Structured JSON Environment Variable (`OIDC_PROVIDERS_JSON`)**
    Define providers inside a single JSON string:
    ```json
    [
      {
        "id": "google",
        "displayName": "Google",
        "provider": "google",
        "issuerUrl": "https://accounts.google.com",
        "clientId": "google-client-id",
        "clientSecret": "google-client-secret",
        "redirectUri": "https://api.approvio.com/auth/web/callback"
      }
    ]
    ```
    *   *Pros:* Extremely clean; fits arbitrary configuration structures without namespace pollution.
    *   *Cons:* Editing JSON strings in Kubernetes/Docker environments can be error-prone.
*   **Option A2: Prefix-based Indexed Environment Variables (`OIDC_PROVIDER_<NAME>_<PROPERTY>`)**
    Configure variables like `OIDC_PROVIDER_google_ISSUER_URL`, `OIDC_PROVIDER_okta_ISSUER_URL`, etc.
    *   *Pros:* Natural fit for environment variables; easily modified in standard CI/CD and Helm values.
    *   *Cons:* Requires dynamic parsing of environment keys on startup.

### Topic B: Frontend Discovery & Configuration Drift
How does the frontend render the available login options (e.g. "Login with Google", "Login with Okta")?

*   **Option B1: Static Frontend Configuration**
    Hardcode available providers in the frontend SPA build configuration.
    *   *Pros:* No additional backend API calls during login screen render.
    *   *Cons:* High risk of configuration drift. If a provider is disabled or added on the backend, the frontend remains out-of-sync unless rebuilt and redeployed.
*   **Option B2: Public Discovery Endpoint (`GET /auth/providers`)**
    Expose a public endpoint on the backend that returns the list of active/enabled providers.
    *   *Pros:* Dynamic, single source of truth. Frontend automatically displays the correct buttons. Instantly respects feature levers.
    *   *Cons:* Small performance/latency overhead on login page load.

### Topic C: User Deduplication & Identity Linking (Security)
If a user with email `alice@company.com` logs in via Google, and later logs in via Okta, how do we handle it?

*   **Option C1: Implicit Email-Based Auto-Linking (Current Behavior)**
    Automatically resolve both logins to the same `User` record based on the `email` unique constraint.
    *   *Pros:* Low friction; seamless cross-provider experience.
    *   *Cons:* **Critical Security Risk**. If an operator configures an untrusted/public IDP, an attacker could register `alice@company.com` on that public IDP and immediately gain access to Alice's Approvio account.
*   **Option C2: Explicit Identity Binding with Verification Whitelists**
    1. Introduce an `Identity` database table mapping `(issuer, subjectId)` to a `userId`.
    2. Enforce OIDC claim verification: require `email_verified: true` in the IDP's userinfo response.
    3. Restrict auto-linking to whitelisted, highly-trusted IDPs or domains, and default to requesting explicit user confirmation (or blocking) for new provider links.

---

## 3. Decision

We will adopt a robust, security-first multi-IDP design.

### 3.1 Configuration Provider — Prefix-Based Environment Variables (Option A2)

**Decision: Option A2.**

We will use prefix-based indexed environment variables (`OIDC_PROVIDER_<NAME>_<PROPERTY>`). This is a two-way door decision — the internal parsing logic in `ConfigProvider` is self-contained, so changing the input format later has zero impact on the rest of the system.

**Rationale:**
*   **Simpler to configure** in Kubernetes (each secret/env var is a separate entry in the `env:` block or `secretKeyRef`), Helm value files (flat keys), and Docker Compose (one `KEY=VALUE` per line). No JSON escaping, no broken-quotes debugging sessions.
*   **Secret isolation.** Client secrets can remain individual Kubernetes Secrets referenced via `secretKeyRef`, each with its own RBAC scope. A single JSON blob forces all secrets into one Secret object.
*   **Implementation cost is equivalent.** The `ConfigProvider` already scans `process.env` for `KMS_MASTER_KEY_V*` keys (see `validateKmsConfig`). We will reuse the exact same pattern: scan keys matching `OIDC_PROVIDER_<ID>_<PROP>`, group by `<ID>`, validate completeness, and fail fast on missing attributes.

**Configuration example:**
```env
# Provider: google
OIDC_PROVIDER_google_DISPLAY_NAME=Google
OIDC_PROVIDER_google_TYPE=google
OIDC_PROVIDER_google_ISSUER_URL=https://accounts.google.com
OIDC_PROVIDER_google_CLIENT_ID=google-client-id
OIDC_PROVIDER_google_CLIENT_SECRET=google-client-secret
OIDC_PROVIDER_google_REDIRECT_URI=https://api.approvio.com/auth/web/callback
OIDC_PROVIDER_google_SCOPES=openid profile email

# Provider: okta
OIDC_PROVIDER_okta_DISPLAY_NAME=Okta SSO
OIDC_PROVIDER_okta_TYPE=custom
OIDC_PROVIDER_okta_ISSUER_URL=https://company.okta.com
OIDC_PROVIDER_okta_CLIENT_ID=okta-client-id
OIDC_PROVIDER_okta_CLIENT_SECRET=okta-client-secret
OIDC_PROVIDER_okta_REDIRECT_URI=https://api.approvio.com/auth/web/callback
```

**Internal representation:** `ConfigProvider` will replace `oidcConfig: OidcProviderConfig` with `oidcProviders: Map<string, OidcProviderConfig>` (keyed by provider ID) plus a getter `getOidcProvider(id: string)`. The existing singular environment variables (`OIDC_PROVIDER`, `OIDC_ISSUER_URL`, etc.) will be removed.

### 3.2 Dynamic Levers & Deactivation

We will introduce a parameterized feature lever `disable_auth_provider` evaluated via OpenFeature.
*   When checking if a provider is active, we evaluate the lever with the context: `{ providerId: provider.id }`.
*   This allows operators to dynamically disable specific login routes (e.g., shutting down Okta during an active Okta outage) without redeploying the app.

### 3.3 Dynamic Frontend Discovery — Public Endpoint (Option B2)

**Decision: Option B2.**

We will implement a new public endpoint: `GET /auth/providers`.

**Response payload:**
```json
[
  { "id": "google", "displayName": "Google", "loginUrl": "/auth/web/login?provider=google" },
  { "id": "okta", "displayName": "Okta SSO", "loginUrl": "/auth/web/login?provider=okta" }
]
```

The endpoint filters out any providers that are dynamically disabled by the `disable_auth_provider` feature lever. The frontend `LoginPage` will query this API during mount and dynamically render login controls.

#### Security Considerations

*   **Rate limiting.** The endpoint will be covered by the existing global rate limiter. Since it is unauthenticated, it is inherently exposed to abuse; however, it returns only static metadata with no PII and the response is extremely small (~200 bytes), making it a low-value target for amplification attacks.
*   **Information disclosure.** The response intentionally omits internal details (issuer URLs, client IDs, OIDC metadata). Only operator-chosen `id` and `displayName` are exposed.

#### Performance Optimizations

*   **`Cache-Control` header:** The response will include `Cache-Control: public, max-age=300` (5 minutes). The browser caches the response, so repeated visits to the login page within 5 minutes don't make any network request. If a CDN/reverse proxy is placed in front of the API in the future (primarily for TLS offloading and DDoS protection — the main reason SaaS products use CDNs, even for authenticated APIs), this header makes the endpoint automatically CDN-cacheable at no extra cost.
*   **Backend in-memory snapshot.** The provider list is computed once at startup and refreshed only when a lever evaluation changes. The controller serves it from memory — no database calls, no Redis calls. Lever evaluations are already local (ADR-005) so the entire request resolves in sub-millisecond time.

### 3.4 Identity Mapping & User Deduplication

**Decision: Start without cross-provider identity linking (simplified C2). Changing provider = changing identity. Full identity linking is a day-2 feature.**

#### Day-1: Strict Provider-Bound Identity

On day-1, we will introduce the `UserIdentity` table and enforce **strict 1:1 provider binding**. There is no automatic cross-provider linking:

1.  **Enforce Email Verification:** The backend will strictly reject logins from any OIDC assertion where `email_verified` is not explicitly `true`. The current `oidc-types.ts` validation already parses `email_verified`, but the `authenticateWithOidc` flow in `AuthService` does not enforce it — this will be fixed.

2.  **Introduce `UserIdentity` Prisma model:**
    ```prisma
    model UserIdentity {
      id         String   @id @db.Uuid
      userId     String   @map("user_id") @db.Uuid
      providerId String   @map("provider_id") @db.VarChar
      subjectId  String   @map("subject_id") @db.VarChar
      email      String   @db.VarChar
      createdAt  DateTime @map("created_at") @db.Timestamp(6)
      user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

      @@unique([providerId, subjectId])
      @@index([userId])
      @@map("user_identities")
    }
    ```

3.  **Authentication logic (day-1):**
    *   If a login matches an existing `UserIdentity` record by `(providerId, subjectId)` → authenticate as that user.
    *   If no `UserIdentity` record matches, and the email does not exist in the `users` table → create a new `User` and a new `UserIdentity`. Standard JIT provisioning, same as today.
    *   If no `UserIdentity` record matches, but the email already exists in the `users` table → **reject the login** with error `IDENTITY_CONFLICT`. The user is directed to log in with their original provider.

The `IDENTITY_CONFLICT` rejection is a conservative default. In practice, for well-known SaaS IDPs (Google, Microsoft, GitHub, ...) auto-linking by email would be safe — email addresses are globally unique and two different people cannot hold the same email across different major providers. The risk only materializes with self-hosted or open-registration IDPs, which is the same operator trust boundary discussed in section 4.1.

#### Why Day-2 for Full Identity Linking

Full cross-provider identity linking (Option C2 allowlists, user-initiated linking from settings) is architecturally compatible with the day-1 schema. The `UserIdentity` table is the same. The difference is only in the linking _policy_. We defer it because:

*   **No additional schema changes** are needed when we add linking later — the `UserIdentity` model supports multiple records per `userId` out of the box.
*   **Security surface is minimized** at launch. Auto-linking, even with allowlists, introduces trust decisions (which IDPs are "trusted enough"?) that are better made with real operational experience.
*   **UX design for explicit linking** (settings page, email verification flow, linking confirmation) is significant and should not block the core multi-IDP infrastructure.

#### Day-2: Explicit Identity Linking (Future)

When implemented, the linking feature will support:
*   **User-initiated linking from settings:** While logged in via their primary identity, a user can initiate an OIDC login with a secondary provider. On successful OIDC callback, if `email_verified: true` and the email matches, a new `UserIdentity` record is created and linked to the existing user.
*   **Auto-link allowlist (optional):** For trusted corporate IDPs (e.g., company-managed Okta/Entra ID), an `AUTO_LINK_ALLOWLIST` configuration can bypass the manual linking requirement.

### 3.5 OpenAPI Path Changes

*   **`GET /auth/providers`** — New public endpoint. Returns array of active providers (`id`, `displayName`, `loginUrl`). No authentication required.
*   **`GET /auth/web/login`** will require a query parameter: `?provider=<provider_id>`. If omitted, and multiple providers exist, it returns `400 Bad Request`.
*   **`POST /auth/cli/initiate`** will accept an optional `provider` in the body payload.
*   **`GET /auth/web/callback`** and **`POST /auth/cli/token`** do not need the provider parameter. We will save the initiating `provider` name inside the database-backed `PkceSession` table when creating the session. During callback, the state resolves to the `PkceSession` record, from which we retrieve the associated provider configuration to execute token exchange.

---

## 4. Security Analysis

### 4.1 Operator Trust & Untrusted IDP Configuration

**Threat:** An operator configures a public/self-serve IDP (e.g., a test Keycloak instance with open registration). An attacker creates account `victim@company.com` on that IDP and logs into Approvio, gaining access to the victim's data.

**Software-level mitigations:**
1.  **`email_verified: true` enforcement.** Rejects any OIDC assertion where the IDP has not verified the email. This blocks trivially spoofed email claims but does _not_ protect against IDPs that lie about verification status (a self-hosted IDP controls that claim).
2.  **Day-1: No cross-provider auto-linking.** Even if an attacker registers a matching email on a secondary IDP, they cannot access the victim's existing account — they are rejected with `IDENTITY_CONFLICT`.
3.  **Day-2 allowlists.** When cross-provider linking is enabled, only IDPs in the `AUTO_LINK_ALLOWLIST` can auto-link.

**Assessment: Organizational concern, not a software one.** The operator is already a highly privileged actor with access to the database, secrets, and infrastructure. Adding a malicious IDP is no different from directly modifying user records or JWT secrets. This is the same trust boundary that applies to email uniqueness across providers — for well-known SaaS IDPs (Google, Microsoft, GitHub), auto-linking by email would be inherently safe because email addresses are globally unique (DNS/MX records ensure one domain → one mail provider). The risk only exists with self-hosted IDPs, and an operator adding such an IDP is exercising administrative privilege. This risk is managed through organizational policy (configuration change review, 2-person rule, audit trails), not software restrictions.

### 4.2 Threat: PKCE Session Provider Confusion

**Threat:** An attacker initiates a login with provider A, but the callback is processed with provider B's configuration, leading to token exchange with the wrong IDP (confused deputy).

**Mitigation:** The `PkceSession` record will store the `providerId` at session creation time. During callback, the system retrieves the provider from the session — not from any user-supplied parameter. The callback endpoint does not accept a `provider` parameter.

### 4.3 Threat: Open Redirect via Provider Login URL

**Threat:** The `GET /auth/web/login?provider=<id>` endpoint redirects to the IDP's authorization endpoint. If `provider` can reference an arbitrary issuer, this becomes an open redirect.

**Mitigation:** The `provider` parameter is validated against the set of statically configured provider IDs. Unknown IDs return `400 Bad Request`. No user-supplied URLs are used in redirect construction — all redirect targets come from the server's startup configuration.

### 4.4 Threat: Discovery Endpoint Enumeration

**Threat:** The `GET /auth/providers` endpoint reveals which IDPs are configured, which could aid in social engineering ("your company uses Okta, here's a fake Okta login page").

**Assessment:** This is a low-severity information disclosure. The same information is visible to any user who navigates to the login page. The endpoint returns only display names, not technical details. The global rate limiter prevents abuse. **Accepted risk.**

### 4.5 Threat: IDP Issuer Spoofing (OIDC Impersonation via DNS/Network Attack)

**Threat:** An attacker intercepts the network path between the Approvio backend and the real IDP, causing the application to communicate with a fake OIDC provider.

**Attack scenario (step by step):**
1.  **Normal behavior:** At startup, the `OidcBootstrapService` calls `https://accounts.google.com/.well-known/openid-configuration` to discover the IDP's token endpoint, userinfo endpoint, and public signing keys. All subsequent auth flows (token exchange, userinfo fetch) use the endpoints from this discovery document.
2.  **DNS hijack:** An attacker compromises DNS resolution — via DNS cache poisoning, BGP route hijacking, or compromising the network between the server and the IDP. When the backend resolves `accounts.google.com`, it receives the attacker's IP address instead of Google's.
3.  **Fake discovery document:** The attacker's server responds to the `/.well-known/openid-configuration` request with a forged document pointing token/userinfo endpoints to the attacker's infrastructure.
4.  **Exploitation:** When a legitimate user initiates login, the authorization code exchange and userinfo requests go to the attacker's server. The attacker can return arbitrary OIDC claims — any `sub`, any `email`, `email_verified: true` — and the Approvio backend trusts the response, granting access to the spoofed identity.

**Why TLS prevents this:** With HTTPS enforced (the default), even if DNS is hijacked and traffic is routed to the attacker, the TLS handshake requires the attacker to present a valid certificate for `accounts.google.com`. Legitimate Certificate Authorities (CAs) only issue certificates to verified domain owners, so the attacker cannot obtain one. The `openid-client` library validates the certificate chain, and the connection fails if it is invalid. This is why `OIDC_ALLOW_INSECURE = false` is critical in production.

**Mitigations:**
*   OIDC discovery URLs are configured statically at startup and never derived from user input.
*   The `openid-client` library validates the `issuer` claim in the discovery document matches the configured URL.
*   TLS is enforced by default (`OIDC_ALLOW_INSECURE` is `false`). The `allowInsecure` flag must be explicitly enabled per-provider, and it is intended only for local development.

### 4.6 Threat: CSRF on Discovery Endpoint

The `GET /auth/providers` endpoint is read-only and returns no user-specific data. It does not modify state. CSRF is not applicable.

---

## 5. Database Schema Changes

### 5.1 New Table: `user_identities`

Create `user_identities` table with columns:
*   `id` (UUID PK)
*   `user_id` (FK → users, ON DELETE CASCADE)
*   `provider_id` (VARCHAR) — the configured provider ID (e.g., `"google"`, `"okta"`)
*   `subject_id` (VARCHAR) — the OIDC `sub` claim from the IDP
*   `email` (VARCHAR) — the email used at the time of identity creation (for auditing)
*   `created_at` (TIMESTAMP)
*   Unique constraint on `(provider_id, subject_id)`
*   Index on `user_id`

### 5.2 Modified Table: `pkce_sessions`

Add `provider_id` column (VARCHAR, NOT NULL) to store which provider initiated the OIDC flow.

---

## 6. Implementation Impact

### 6.1 Backend Changes

| Component | Change |
|---|---|
| `ConfigProvider` | Replace `oidcConfig: OidcProviderConfig` with `oidcProviders: Map<string, OidcProviderConfig>`. Remove singular env var parsing. |
| `OidcBootstrapService` | Perform OIDC discovery for **each** configured provider at startup (parallelized). Store a `Map<string, client.Configuration>`. |
| `OidcClient` | Accept `providerId` parameter in `getAuthorizationUrl`, `exchangeCodeForTokens`, and `getUserInfo`. Resolve the correct `client.Configuration` from the bootstrap map. |
| `AuthService` | Accept `providerId` in `initiateOidcLogin`. Store `providerId` in `PkceSession`. Retrieve it during callback. Add `email_verified` enforcement in `authenticateWithOidc`. Replace `authenticateOrRegisterOidcUser` with identity-aware logic. |
| `PkceService` / `PkceSession` | Extend `PkceStorageData` with `providerId`. |
| New: `AuthProvidersController` | `GET /auth/providers` — returns filtered list of active providers. |
| New: `UserIdentityRepository` | CRUD operations on `user_identities` table. |

### 6.2 Frontend Changes

| Component | Change |
|---|---|
| `LoginPage` | Fetch `GET /auth/providers` on mount. Render dynamic provider buttons. |
| Auth redirect logic | Include `provider` query parameter in login initiation URL. |

### 6.3 CLI Changes

| Component | Change |
|---|---|
| `auth login` command | If `GET /auth/providers` returns multiple providers, prompt the user to select one. Pass `provider` in the `POST /auth/cli/initiate` body. |

---

## 7. Consequences

### Positive
*   **Seamless Integration:** Frontend adapts dynamically; adding an IDP on the backend immediately exposes it to web and CLI clients.
*   **Granular Outage Mitigation:** We can disable a single malfunctioning IDP via Unleash/OpenFeature levers without impacting other providers.
*   **Enhanced Security:** Prevents rogue IDP identity theft through strict `email_verified` verification and strict provider-bound identity (day-1). Day-2 linking adds flexibility with allowlists.
*   **Clean Separation of Concerns:** Frontend is completely decoupled from OIDC endpoint configuration details.
*   **Minimal Login Page Latency:** `Cache-Control` headers and in-memory backend caching ensure the discovery endpoint adds negligible overhead.

### Negative / Mitigations
*   **Database Migration Required:** Migration is needed to introduce the `UserIdentity` table and add a `provider` column to `PkceSession`.
    *   *Mitigation:* Straightforward Liquibase migration. No data backfill needed since the service is not yet in production.
*   **CLI UX Complexity:** CLI client must support selecting a provider if multiple options are available.
    *   *Mitigation:* If `GET /auth/providers` returns multiple providers, the CLI will prompt the user to pick one or accept a `--provider` flag. If only one provider is available, it is selected automatically.
*   **No Cross-Provider Switching on Day-1:** Users who want to change their login provider must wait for the day-2 linking feature.
    *   *Mitigation:* This is an explicit security trade-off. An admin can manually create a `UserIdentity` record via the database as a temporary workaround for urgent cases.
*   **Startup Latency:** OIDC discovery is performed for each provider at startup. With N providers, this could add latency.
    *   *Mitigation:* Discovery calls are parallelized. Typical OIDC discovery takes 100–300ms. Even with 5 providers in parallel, total overhead is under 500ms.
