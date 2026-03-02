# Authentication Configuration

This document describes how to configure the authentication for the application. The application uses OpenID Connect (OIDC) for user authentication and supports various Identity Providers (IDPs) such as Google, Okta, and others.

## Configuration

Authentication is configured via environment variables.

### High Privilege Token Mode

The application supports a "step-up" authentication flow where users can exchange their standard session for a high privilege token by re-authenticating. This flow is used for sensitive operations.
This feature requires the IDP to support this kind of interaction, if using a custom provider, the mechanism will be disabled.

You can explicitly control this mode via a top-level environmental variable:

- `DISABLE_HIGH_PRIVILEGE_MODE`: (Optional) Boolean flag to globally disable the high privilege token mode. Defaults to `false`.

> [!IMPORTANT]
> The high privilege flow **does not support automatic registration**. Only pre-existing users can complete the step-up process. If an authenticated user from the IDP does not match an existing user in Approvio, the flow will fail.

> `DISABLE_HIGH_PRIVILEGE_MODE` will only disable the authentication flow. If the resources have been configured to require a high-privilege token, the application will still attempt to perform the high-privilege token flow, but it will fail fast.

## OIDC Provider Configuration

These variables are required for all providers:

- `OIDC_PROVIDER`: The type of OIDC provider being used. Acceptable values are `auth0`, `zitadel`, `keycloak`, or `custom`. Defaults to `custom`.
- `OIDC_ISSUER_URL`: The Issuer URL of the IDP (e.g., `https://accounts.google.com`).
- `OIDC_CLIENT_ID`: The Client ID obtained from the IDP.
- `OIDC_CLIENT_SECRET`: The Client Secret obtained from the IDP.
- `OIDC_REDIRECT_URI`: The callback URL where the IDP redirects after login (e.g., `http://localhost:3000/auth/web/callback`).
- `OIDC_SCOPES`: (Optional) Space-separated list of scopes to request. Defaults to `openid profile email`.

### Discovery (Recommended)

By default, the application uses OIDC Discovery (`.well-known/openid-configuration`) to automatically fetch the provider's configuration (authorization endpoint, token endpoint, etc.). This works out-of-the-box for most compliant providers like Google and Okta.

### Manual Configuration

If your provider does not support OIDC Discovery, you can manually configure the endpoints. To bypass the discovery process, you must set **ALL** of the following variables:

- `OIDC_AUTHORIZATION_ENDPOINT`: The authorization endpoint URL.
- `OIDC_TOKEN_ENDPOINT`: The token endpoint URL.
- `OIDC_USERINFO_ENDPOINT`: The userinfo endpoint URL.

**Note:** If you choose to configure manually, you must provide **all three** endpoints. If you provide some but not all, the application will throw an error at startup to prevent misconfiguration.

## Examples

### Google

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Configure the OAuth consent screen.
3. Create OAuth 2.0 credentials (Client ID and Secret) for Web application type.
4. Set the authorized redirect URI to your application's callback URL.

```env
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=your-google-client-id
OIDC_CLIENT_SECRET=your-google-client-secret
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
OIDC_SCOPES=openid profile email
```

### Custom / Manual Configuration

For a provider that requires manual endpoint configuration:

```env
OIDC_ISSUER_URL=https://idp.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback

# Manual overrides
OIDC_AUTHORIZATION_ENDPOINT=https://idp.example.com/oauth2/authorize
OIDC_TOKEN_ENDPOINT=https://idp.example.com/oauth2/token
OIDC_USERINFO_ENDPOINT=https://idp.example.com/oauth2/userinfo
```

## Authentication Flows

Approvio utilizes a Token Mediated Backend architecture to authenticate requests. The authentication process is categorized into three primary flows: Web, CLI, and Agent (Machine-to-Machine).

### 1. Web Flow (Browser + Frontend)

The Web flow uses standard OIDC redirection and secures the session via `httpOnly` cookies.

**Endpoints:** `GET /auth/web/login`, `GET /auth/web/callback`, `POST /auth/web/refresh`, `POST /auth/web/initiatePrivilegedTokenExchange`, `POST /auth/web/exchangePrivilegedToken`

```mermaid
sequenceDiagram
    participant F as Frontend (Browser)
    participant W as WebAuthController
    participant O as OIDC Provider

    F->>W: GET /auth/web/login
    W-->>F: 302 Redirect to OIDC Provider
    F->>O: User Authentication & Consent
    O-->>F: 302 Redirect to /auth/web/callback
    F->>W: GET /auth/web/callback?code=...&state=...
    Note over W,O: Backend exchanges code for OIDC tokens <br/> server-to-server via OidcClient
    Note over W: Validates PKCE & JIT Provisions User <br/> Generates Approvio TokenPair
    W-->>F: 302 Redirect to Frontend URL <br/> (Sets httpOnly access_token + refresh_token Cookies)

    Note over F,W: Token Refresh
    F->>W: POST /auth/web/refresh (refresh_token cookie)
    W-->>F: 204 No Content (Rotates Cookies)
```

### 2. CLI Flow (Terminal + Browser)

The CLI flow involves initiating login via the CLI, performing authentication on the host browser, and finally exchanging the code for programmatic tokens on the CLI.

**Endpoints:** `POST /auth/cli/initiate`, `POST /auth/cli/token`, `POST /auth/cli/refresh`, `GET /auth/cli/initiatePrivilegedTokenExchange`, `POST /auth/cli/exchangePrivilegedToken`

```mermaid
sequenceDiagram
    participant C as CLI
    participant B as Host Browser
    participant A as CliAuthController
    participant O as OIDC Provider

    C->>A: POST /auth/cli/initiate { redirectUri }
    A-->>C: 200 { authorizationUrl }
    C->>B: Opens local Browser
    B->>O: User Authentication & Consent
    O-->>B: 302 Redirect to CLI local server (redirectUri)
    B-->>C: Returns code & state
    C->>A: POST /auth/cli/token { code, state }
    Note over A,O: Backend exchanges code for OIDC tokens <br/> server-to-server via OidcClient
    Note over A: Validates PKCE & JIT Provisions User <br/> Generates Approvio TokenPair
    A-->>C: 200 Returns Approvio Access & Refresh Tokens (JSON)

    Note over C,A: Token Refresh
    C->>A: POST /auth/cli/refresh { refreshToken }
    A-->>C: 200 Returns new Access & Refresh Tokens (JSON)
```

### 3. Agent Flow (Machine-to-Machine)

Agents use an asymmetric key-pair (JWT Assertion) mechanism to securely authenticate without interactive logins.

**Endpoints:** `POST /auth/agents/challenge`, `POST /auth/agents/token`, `POST /auth/agents/refresh`

```mermaid
sequenceDiagram
    participant M as Trusted Agent
    participant A as AuthController

    M->>A: POST /auth/agents/challenge { agentId }
    A-->>M: 200 Returns PKCE Challenge
    Note over M: Agent signs the challenge <br/> with its private key (Client Assertion JWT)
    M->>A: POST /auth/agents/token { clientAssertion }
    Note over A: Validates JWT Signature <br/> JIT Provisioning (if applicable)
    A-->>M: 200 Returns AgentTokenResponse (Access + Refresh Tokens)

    Note over M,A: Token Refresh (DPoP-bound)
    M->>A: POST /auth/agents/refresh { refreshToken } + DPoP header
    Note over A: Validates DPoP proof <br/> Verifies method & URL binding
    A-->>M: 200 Returns new TokenResponse
```

## Troubleshooting

- **Discovery Failed**: Ensure `OIDC_ISSUER_URL` is correct and accessible from the server. Check if `.well-known/openid-configuration` exists at that URL.
- **Redirect Mismatch**: Ensure `OIDC_REDIRECT_URI` exactly matches the one registered with your IDP.
- **Scopes**: Ensure the requested scopes are allowed for your client.
