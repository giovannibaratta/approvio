# Health and Ping Endpoints

This document describes the health and uptime monitoring endpoints available in the system for infrastructure and operations teams.

## Endpoints Overview

| Endpoint | Path | Dependencies Checked | Rate Limited | Caching | Primary Use Case |
|---|---|---|---|---|---|
| **Ping** | `/ping` | None | No | None | Public uptime monitors, external services |
| **Health** | `/internal/health` | DB, Redis (Queue) | Yes (1 req/s per IP) | Yes (1s default) | Load balancer probes, Kubernetes liveness/readiness |

### `GET /ping`

The `/ping` endpoint is a lightweight, public route designed for external uptime monitoring services. It performs no internal dependency checks and returns a static response, minimizing overhead and risk of amplification attacks.

**Response:**
`200 OK`
```json
{
  "status": "OK"
}
```

### `GET /internal/health`

The `/internal/health` endpoint is intended for internal infrastructure use (e.g., Load Balancers, Kubernetes probes). It verifies the health of core dependencies such as the database and Redis cache.

To prevent abuse and mitigate denial-of-service risks:
- The endpoint is located under the `internal/*` path. It is highly recommended to block this path from public traffic at the reverse proxy or WAF level.
- Requests are rate-limited to 1 request per second per IP address. Exceeding this limit will result in a `429 Too Many Requests` response.
- Dependency check results are cached in-memory.

**Response (Healthy):**
`200 OK`
```json
{
  "status": "OK"
}
```

**Response (Unhealthy):**
`503 Service Unavailable`
```json
{
  "status": "DEPENDENCY_ERROR",
  "message": "QUEUE_HEALTH_CHECK_FAILED"
}
```

## Configuration

The `/internal/health` endpoint uses in-memory caching to reduce the load on dependencies. The cache TTL can be configured via environment variables.

| Environment Variable | Description | Default |
|---|---|---|
| `HEALTH_CACHE_TTL_MS` | TTL for the health check result cache in milliseconds | `1000` |

## Deployment behind Reverse Proxy, Load Balancer, or WAF

For general infrastructure deployment guidelines (including header configuration and restricting public access to `/internal/*` endpoints), see the [Proxy and WAF Deployment Guide](proxy-waf-deployment.md).
