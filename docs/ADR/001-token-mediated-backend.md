# ADR-001: Token Mediated Backend for Browser Authentication

**Status:** Accepted  
**Date:** 2026-03-01  
**Context:** OIDC authentication flow improvements for browser, CLI, and agent clients

## Problem

The current authentication flow stores JWT access tokens and refresh tokens in `localStorage`, making them accessible to JavaScript. This exposes them to Cross-Site Scripting (XSS) attacks: any malicious script injected into the page (via a vulnerable npm dependency, CDN compromise, or input validation flaw) can exfiltrate tokens and gain persistent access to the user's account from any machine.

Additionally, the current flow has a UX problem: after IDP authentication, the user is redirected to a backend JSON page (`/auth/success`) and never returns to the frontend.

## Options Considered

### Option 1: Token in localStorage (Current)

Frontend receives tokens in JSON, stores in `localStorage`, attaches `Authorization: Bearer` header on every request.

- ✅ Simple, stateless
- ❌ Tokens accessible to JavaScript → XSS can steal them
- ❌ Stolen tokens provide persistent, portable access

### Option 2: Full BFF (Backend for Frontend)

All auth state is managed server-side via opaque session cookies. Frontend never sees tokens. Backend proxies all API calls, attaching tokens server-side.

- ✅ Maximum XSS protection (no tokens in browser at all)
- ❌ Requires server-side session store (Redis) for every request
- ❌ Stateful — every API call requires a session lookup
- ❌ Poor microservice fit — if auth is extracted to a separate service, every request requires a network hop to validate the session
- ❌ Adds a proxy layer between frontend and API
- ❌ Three distinct auth mechanisms (session cookie, Bearer header for CLI, challenge-response for agents)

### Option 3: Token Mediated Backend (Chosen)

JWT access token and refresh token are delivered via **HttpOnly cookies** for browser clients. The same JWT is used for authorization — backend reads it from the cookie. CLI and agents continue using `Authorization: Bearer` header.

- ✅ HttpOnly cookies are invisible to JavaScript → XSS cannot steal tokens
- ✅ Worst-case XSS: attacker can make requests during the active session, but cannot exfiltrate tokens for use elsewhere
- ✅ Stateless JWT verification — no Redis session lookup needed
- ✅ Microservice-friendly — any service can verify JWT with the public key
- ✅ Single JWT format across all clients
- ⚠️ Requires CSRF protection (`SameSite` cookie attribute)
- ⚠️ Cookie size limit (~4KB) — JWT payload must stay lean

## Decision

**Use Option 3: Token Mediated Backend.**

### Rationale

The full BFF architecture (Option 2) is the theoretical gold standard for browser security, but it introduces **stateful session management** that conflicts with our architectural goals:

1. **Microservice readiness**: We plan to extract auth into a separate service. With BFF, every API request would require a network hop to the auth service to validate the session. With JWT in cookies, each service validates the token locally using the public key.

2. **Unified auth model**: With Token Mediated Backend, all clients (browser, CLI, agents) use the same JWT format. The only difference is the transport mechanism (cookie vs header). This simplifies the auth guard to a single JWT verification path.

3. **Operational simplicity**: BFF requires a dedicated session store (Redis) that must be highly available — every request depends on it. Our current Redis usage (step-up tokens, PKCE) is non-critical and short-lived. Making it the session backbone is a significant operational burden.

4. **Adequate security**: The token mediated approach eliminates the primary XSS risk (token exfiltration). The remaining risk — same-session abuse during an active XSS attack — is also present in full BFF (an attacker can still make requests using the session cookie during the XSS window). The marginal security gain of full BFF does not justify the architectural cost.

### CSRF Mitigation

Since cookies are sent automatically, CSRF protection is required:

- `SameSite=Lax` on access token cookie: blocks cross-origin POST/PUT/DELETE
- `SameSite=Strict` on refresh token cookie: sent only on same-origin navigation
- Refresh token cookie scoped to `Path=/auth/web/refresh` — not sent on other requests

### Endpoint Separation

Browser and CLI use **separate endpoints** to avoid conditional behavior based on input format:

| Concern            | Browser Endpoint                                                 | CLI Endpoint                                |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| Login callback     | `GET /auth/web/callback` (cookie + redirect)                     | `POST /auth/token` (JSON response)          |
| Token refresh      | `POST /auth/web/refresh` (cookie in/out)                         | `POST /auth/refresh` (JSON in/out)          |
| Privilege initiate | `POST /auth/web/initiatePrivilegedTokenExchange` (JSON response) | unchanged                                   |
| Privilege exchange | `POST /auth/web/exchangePrivilegedToken` (cookie + JSON)         | `POST /auth/exchangePrivilegedToken` (JSON) |

### CLI Redirect URI Security (RFC 8252 / RFC 9700)

Per [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) (OAuth for Native Apps) and [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) (OAuth Security BCP):

- CLI applications use **loopback interface redirect** (`http://localhost:<port>/callback`)
- The backend validates that requested redirect URIs match `http://localhost` or `http://127.0.0.1` (port flexibility allowed per RFC)
- All other redirect URI values are rejected
- The redirect URI used during token exchange must exactly match the one used during authorization

## References

- [RFC 8252 — OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
- [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700)
- [OAuth 2.0 for Browser-Based Apps (Draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
