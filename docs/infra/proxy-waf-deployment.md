# Deployment behind Reverse Proxy, Load Balancer, or WAF

This document provides deployment guidelines for hosting Approvio services behind a reverse proxy (e.g., Nginx, Envoy, Apache), a Load Balancer (e.g., AWS Application Load Balancer), or a Cloud WAF (e.g., Cloudflare, Akamai).

When deploying in these environments, configure your proxies and the application correctly to ensure accurate client IP identification, correct audit logging, and secure route access.

---

## 1. Proxy Header Configuration

Ensure your upstream proxy or load balancer is configured to inject/preserve the standard forwarding headers:

| Header | Description | Required Value / Action |
|---|---|---|
| `X-Forwarded-For` | Identifies the originating IP address of a client. | Must be set by the edge proxy. Ensure internal proxies append to it. |
| `X-Forwarded-Proto` | Identifies the protocol (HTTP or HTTPS) used by the client. | Should match the protocol used at the edge. |
| `X-Forwarded-Host` | Identifies the original host requested by the client. | Should match the original `Host` header. |

> [!CAUTION]
> **WAF/Proxy Spoofing Prevention**:
> Ensure that your edge reverse proxy strips or overrides any client-supplied `X-Forwarded-For` headers before forwarding the request. Clients must not be allowed to spoof their IP by sending custom forwarding headers.

---

## 2. Path Restriction and Routing Rules

Some routes inside the Approvio API are reserved for internal or operations use only. You should enforce these restrictions at your reverse proxy or WAF layer to minimize attack surfaces.

### Block `/internal/*` routes

All endpoints under the `/internal/*` path (e.g., `/internal/health`, `/internal/workflow-templates`) must be restricted from public internet access.

- **Internal Probe Allowed**: Allow Kubernetes liveness/readiness probes or internal metrics monitors to access `/internal/health`.
- **Public Disallowed**: Drop requests matching `/internal/*` originating from external traffic.
