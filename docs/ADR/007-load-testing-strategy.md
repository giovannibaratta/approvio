# ADR-007: Load Testing Strategy

## Problem

Approvio has no load testing strategy. As the system grows, we need confidence that the API, workers, and infrastructure dependencies (PostgreSQL, Redis, OIDC) behave acceptably under sustained and peak load. We also need a **repeatable framework** so that load tests can be re-run as the system evolves, not a one-shot benchmarking exercise.

Key challenges:

1. **What to test** — the system has a synchronous API path, an asynchronous worker path, and several external integrations. Not all components are equally interesting under load.
2. **Synthetic data quality** — naïve load tests (e.g., hammering `/health`) tell us nothing. Tests must exercise realistic data flows and hit meaningful code paths (DB queries, permission checks, queue enqueuing).
3. **Measurement reliability** — the system runs on commodity/developer hardware, making raw latency numbers unreliable. We need a measurement approach that yields actionable results despite noisy environments.

## What to Test

### Tier 1: API — Synchronous Request Path

These are the HTTP endpoints that users and agents call directly. They exercise the full NestJS stack: rate limiting, authentication guards, permission checks, domain logic, Prisma/PostgreSQL queries, and response serialization.

**High-value targets (complex write paths):**

| Endpoint                                           | Why it matters                                                                                                                                 |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /workflows`                                  | Creates a workflow, checks quotas, evaluates approval rules, enqueues status-change events. Exercises DB writes + Redis queue.                 |
| `POST /workflows/{workflowId}/vote`                | Triggers vote recording, workflow recalculation, potential status transition, and downstream event emission. The most business-critical write. |
| `POST /workflow-templates`                         | Creates templates with embedded actions (webhook, email, Slack). Involves JSON validation, encryption of sensitive fields, quota enforcement.  |
| `POST /groups` / `POST /groups/{groupId}/entities` | Group creation and membership mutations. Exercises hierarchy traversal and permission checks.                                                  |

**High-value targets (read paths under fan-out):**

| Endpoint                                       | Why it matters                                                                                               |
| :--------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `GET /workflows`                               | Paginated list with filtering. Exercises Prisma query builder, pagination logic, and potential N+1 patterns. |
| `GET /audit-logs`                              | Range-scanned, filtered read over a potentially large table. Tests index strategy (see ADR-004).             |
| `GET /workflow-templates/{templateIdentifier}` | Reads encrypted fields, decrypts in-process — reveals crypto overhead under load.                            |

**Low-value targets (skip or minimal coverage):**

- `/health` — trivially fast, does not exercise meaningful logic.
- `/auth/web/login`, `/auth/web/callback` — dominated by external OIDC round-trips. Load testing the OIDC mock is not useful; load testing a real OIDC provider is out of scope.
- Static auth token endpoints (`/auth/info`) — effectively a cache lookup.

### Tier 2: Workers — Asynchronous Processing Path

Workers consume BullMQ jobs from Redis. Their throughput determines how quickly side-effects (emails, webhooks, Slack notifications) are dispatched after a workflow state change.

**What to stress:**

| Processor                                 | What it exercises                                                                                                                                            |
| :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowEventsProcessor`                 | Deserializes events, fetches workflow from DB, creates action tasks (DB writes), enqueues follow-up jobs. The fan-out multiplier per workflow status change. |
| `WorkflowExpirationSweepProcessor`        | Periodic sweep query over potentially all active workflows. Tests DB query performance under growing dataset size. Exercises Redis distributed lock.         |
| `WorkflowRecalculationProcessor`          | Re-evaluates workflow status. Exercises OCC (optimistic concurrency control) retry paths under contention.                                                   |
| Action processors (email, webhook, Slack) | Execute outbound HTTP/SMTP calls. Tests connection pool exhaustion and retry backoff under volume.                                                           |

**Testing approach:** Workers are best tested indirectly — by flooding the API with write operations (workflow creation + votes) and observing queue depth, processing latency, and job failure rates. Direct queue injection (publishing synthetic BullMQ jobs) is useful for isolating worker throughput from API throughput.

### Tier 3: Infrastructure Dependencies

Not tested directly, but monitored during load tests:

- **PostgreSQL** — connection pool saturation, query latency percentiles, lock contention.
- **Redis** — memory usage, queue depth growth rate, command latency.
- **OIDC provider** — not load-tested (use pre-generated JWT tokens to bypass).

## How to Load Test Effectively

### Principle 1: Generate Synthetic but Structurally Valid Data

Bad load tests use hardcoded payloads. This leads to:

- Cache hits that mask real performance (same workflow ID fetched repeatedly).
- Constraint violations that short-circuit the code path (duplicate names, quota limits).
- Unrealistic data distributions (all workflows in one space, one user doing all votes).

**Data generation strategy:**

1. **Seed phase (setup fixture):** Before the load test, run a setup script that creates a realistic organizational topology:
   - 1 organization with N spaces (e.g., 5–10).
   - M groups with varied membership sizes (3–50 entities).
   - K workflow templates per space, each with different action configurations (email-only, webhook+email, all three).
   - Pre-register L users and A agents with appropriate roles and permissions.

2. **Execution phase (test traffic):** Each virtual user (VU) operates within the seeded topology:
   - Picks a random space and template (weighted distribution, not uniform — simulate a "hot" space).
   - Creates a workflow with a unique name (UUID suffix).
   - Submits votes from different pre-seeded users (respecting the approval rules of the template).
   - Reads workflow status, lists workflows with pagination, queries audit logs.

3. **Data uniqueness:** Every write operation must produce a unique entity. Use UUIDs or monotonic counters for names. This avoids hitting unique-constraint rejections that would artificially reduce write throughput.

4. **Quota headroom:** Seed quotas with limits high enough that quota enforcement runs but never blocks (e.g., `MAX_CONCURRENT_WORKFLOWS = 100000`). This ensures the quota check code path executes without becoming the bottleneck.

### Principle 2: Authenticate Realistically but Cheaply

The system uses JWT-based authentication. Performing a full OIDC flow per virtual user is expensive and slow.

**Approach:** Pre-generate a pool of valid JWT tokens during the seed phase. Each VU picks a token from the pool. Tokens should:

- Map to distinct pre-seeded users (not all requests as the same user — this would mask per-user rate limiting and permission evaluation).
- Have long expiration times (avoid token refresh during the test).
- Be generated via the existing `/auth/cli/token` endpoint against a mock OIDC provider, or by directly signing JWTs with a known test OIDC key.

### Principle 3: Hit the Right Code Paths, Not Just the Router

A load test that only exercises "happy path 200 OK" responses is incomplete. Realistic traffic includes:

- **Mixed read/write ratio:** Real usage is heavily read-biased (e.g., 80% reads, 20% writes). Simulate this.
- **Error paths:** Include requests that trigger 403 (permission denied), 409 (conflict/OCC), 429 (rate limit). These paths exercise guards, error mappers, and rate limiter Redis lookups.
- **Pagination:** Don't just `GET /workflows`. Walk through pages (`offset=0`, `offset=20`, `offset=40`) to exercise cursor/offset behavior at depth.
- **Concurrent vote contention:** Multiple VUs voting on the same workflow simultaneously. This triggers the OCC retry path in `WorkflowRecalculationProcessor` — a critical correctness and performance path.

### Principle 4: Separate Concerns — API vs. Worker vs. End-to-End

Run three distinct test profiles:

| Profile         | What it isolates                                           | Setup                                                                                                                                       |
| :-------------- | :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **API-only**    | HTTP request handling, DB query performance, rate limiting | Disable worker processing (or let queues drain naturally). Measure API response times.                                                      |
| **Worker-only** | Queue consumption throughput, outbound integration latency | Pre-fill Redis queues with synthetic jobs. Measure processing rate and job failure rate.                                                    |
| **End-to-end**  | Full system behavior under realistic load                  | Run API load + workers simultaneously. Measure both API latency and event processing delay (time from vote submission to webhook delivery). |

## How to Measure Performance

### The Commodity Hardware Problem

The system will be load-tested on developer machines or small cloud instances, not dedicated performance labs. This means:

- **Absolute latency numbers are meaningless.** A p99 of 120ms on a laptop tells you nothing about production.
- **Relative comparisons are valuable.** If the same test on the same machine shows p99 going from 120ms to 450ms after a code change, that's a signal.
- **Resource saturation is always meaningful.** CPU at 100%, connection pool exhausted, OOM — these happen regardless of hardware speed.

### What to Measure

#### Latency Metrics (per endpoint)

| Metric           | Why                                                                                                  |
| :--------------- | :--------------------------------------------------------------------------------------------------- |
| **p50 (median)** | Typical user experience.                                                                             |
| **p95**          | "Slow but tolerable" boundary.                                                                       |
| **p99**          | Tail latency — often dominated by GC pauses, DB lock waits, or connection pool queuing.              |
| **Max**          | Worst-case. Useful for detecting outlier pathologies (e.g., a single query scanning the full table). |

Always report percentiles, never averages. Averages hide bimodal distributions (e.g., 90% of requests at 10ms, 10% at 2000ms = average of 209ms, which describes nobody's experience).

#### Throughput Metrics

| Metric                          | Why                                                                                                                                        |
| :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **Requests/second (sustained)** | The rate the system handles without error rate climbing.                                                                                   |
| **Error rate (%)**              | Percentage of 5xx responses. Should stay below 1% at target load. Non-5xx errors (429, 409) are expected and should be tracked separately. |
| **Queue depth over time**       | If queue depth grows monotonically during the test, workers cannot keep up — this is a capacity signal regardless of hardware.             |

#### Resource Utilization

| Metric                              | Why                                                                                                                                                  |
| :---------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js event loop lag**          | If event loop lag exceeds ~100ms, the process is CPU-saturated. This is hardware-independent — it means the code is doing too much synchronous work. |
| **PostgreSQL active connections**   | Approaching the connection pool limit signals contention.                                                                                            |
| **PostgreSQL query duration (p95)** | Slow queries under load often indicate missing indexes or lock contention.                                                                           |
| **Redis memory / command latency**  | Queue backpressure and rate limiter performance.                                                                                                     |
| **Heap used (RSS)**                 | Memory leaks manifest as monotonically growing RSS over a sustained test.                                                                            |

### Common Pitfalls

1. **Warm-up bias.** The first N seconds of a load test include JIT compilation, connection pool initialization, and Prisma query plan caching. Discard the first 30–60 seconds of data (configure the tool's "ramp-up" period).

2. **Coordinated omission.** If the load generator waits for a response before sending the next request, slow responses reduce the request rate, making the system appear faster than it is. Use an **open-loop** load generator (constant arrival rate) rather than a closed-loop one (fixed concurrency). k6 supports this via the `constant-arrival-rate` executor.

3. **Client-side bottleneck.** If the load generator machine is CPU-saturated or network-limited, it becomes the bottleneck, not the system under test. Monitor the load generator's own CPU and network. Run the load generator on a separate machine or container from the system under test.

4. **Single-connection pooling.** If all VUs share a single HTTP connection (HTTP/1.1 keep-alive with one socket), TCP head-of-line blocking limits concurrency. Ensure the load tool opens multiple connections.

5. **Clock drift in distributed setups.** If the load generator and the system under test are on different machines, use NTP-synchronized clocks for event-time correlation. Better yet, measure round-trip latency from the load generator's perspective (which doesn't require clock sync).

6. **Not controlling for background noise.** On a developer laptop, a browser tab, Slack, or a Docker image pull can spike CPU and skew results. Close unnecessary processes. Better yet, run tests in a dedicated container or VM.

7. **Testing with an empty database.** Performance characteristics change dramatically with dataset size. Seed the database with a realistic volume of historical data (e.g., 10,000 completed workflows, 50,000 audit log entries) before starting the load test. Index performance, query plan choices, and page cache behavior all depend on table size.

8. **Ignoring GC pauses.** Node.js V8 garbage collection causes stop-the-world pauses that show up as latency spikes. Monitor GC activity (`--expose-gc`, `process.memoryUsage()`, or `node --prof`). If p99 latency is dominated by GC, the issue is memory allocation patterns, not I/O.

## Observability During Load Tests

The "What to Measure" section above lists the metrics. This section covers _how_ to collect them — which tools and libraries to run alongside the system under test.

### Node.js — Application Process Monitoring

Node.js monitoring during load tests operates at two levels: external process metrics (event loop lag, heap, GC) and internal code-path analysis (where is time being spent within our code?).

#### External Process Metrics (No Code Changes)

These tools observe the Node.js process from outside, without modifying application code:

| Tool                                     | What it provides                                                                       | How to use                                                                                                                                                              |
| :--------------------------------------- | :------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`node --prof`**                        | V8 tick-based CPU profile. Shows which functions consume the most CPU time.            | Run the NestJS process with `node --prof dist/main.js`. After the test, process the log with `node --prof-process isolate-*.log > profile.txt`. Identify hot functions. |
| **`node --prof-process`**                | Converts the raw `--prof` output into a human-readable report.                         | Post-test analysis only — no runtime overhead during the test itself.                                                                                                   |
| **`process.memoryUsage()`**              | Heap used, RSS, external, array buffers.                                               | Already available in Node.js. Log periodically (e.g., every 10s) via a simple interval. Useful for detecting memory leaks during soak tests.                            |
| **`perf_hooks.monitorEventLoopDelay()`** | Histogram of event loop delays. The built-in Node.js API for measuring event loop lag. | Create a histogram monitor at startup, sample percentiles periodically. No external dependency needed.                                                                  |

#### Internal Code-Path Analysis (Profiling)

**Do we need an instrumentation library for internal code paths?**

For load testing purposes: **no, not initially.** The goal of load testing is to find bottlenecks and breaking points at the system level (which endpoint is slow? which query? which worker?). The built-in tools above are sufficient for initial analysis.

However, if load tests reveal a specific endpoint or worker is slow, and `--prof` output doesn't clearly pinpoint the cause, the following tools provide deeper flamegraph-based analysis:

| Tool                                                             | Purpose                                                                                                                                                 | When to use                                                                                                                                                 |
| :--------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chrome DevTools** (`node --inspect`)                           | Interactive CPU profiling, heap snapshots, async stack traces. The gold standard for deep interactive profiling — always up-to-date with the V8 engine. | First-pass triage and deep-dives. Start the app with `node --inspect dist/main.js`, open `chrome://inspect`, record a CPU profile under load.               |
| [**0x**](https://github.com/davidmarkclements/0x)                | Generates interactive HTML flamegraphs from V8 profiler output. Battle-tested, actively maintained, zero-config.                                        | Quick visual answer to "which function is hot?" Run `npx 0x -- node dist/main.js`, then replay requests. Produces a self-contained HTML flamegraph on exit. |
| [**@platformatic/flame**](https://github.com/platformatic/flame) | Modern flamegraph generator that also produces a Markdown analysis file suitable for AI-assisted interpretation.                                        | Same use case as 0x, but with an AI-friendly output format. Useful when the flamegraph is too dense to interpret visually.                                  |

> **Note on Clinic.js:** Clinic.js (Doctor, Flame, Bubbleprof) was previously the recommended suite for Node.js diagnostics but has not been maintained since 2023 and may not work reliably with recent Node.js versions. The tools above cover the same use cases.

**Usage pattern:** Run these in a targeted reproduction, not during the full load test. Isolate the slow endpoint, replay a small number of requests, and analyze the output.

```bash
# Example: generate a flamegraph for the NestJS API server
npx 0x -- node dist/main.js
# Then hit the slow endpoint with a small k6 script (e.g., 10 VU, 30s)
# 0x will produce a flamegraph HTML file on exit (Ctrl+C)

# Alternative: Chrome DevTools for interactive profiling
node --inspect dist/main.js
# Open chrome://inspect → click "inspect" → Performance tab → Record
```

#### Application-Level Instrumentation (OpenTelemetry)

For a more structured, long-term approach, **OpenTelemetry** provides automatic instrumentation for NestJS, Prisma, BullMQ, and HTTP clients — generating distributed traces that show the full request lifecycle (HTTP handler → guard → service → Prisma query → Redis enqueue).

| Component              | Auto-instrumentation package                 |
| :--------------------- | :------------------------------------------- |
| HTTP (Express/Fastify) | `@opentelemetry/instrumentation-http`        |
| NestJS                 | `@opentelemetry/instrumentation-nestjs-core` |
| Prisma                 | `@prisma/instrumentation`                    |
| BullMQ/Redis           | `@opentelemetry/instrumentation-ioredis`     |
| DNS                    | `@opentelemetry/instrumentation-dns`         |

**Recommendation:** OpenTelemetry is **not required for initial load testing**. It is a valuable investment for production observability and for advanced load test analysis, but it introduces a non-trivial setup (trace collector, trace backend, configuration). Consider it a **Phase 2 addition** once the basic load testing framework is operational.

If adopted, use a local [Jaeger](https://www.jaegertracing.io/) instance as the trace backend during load tests — it runs as a single Docker container and provides a web UI for inspecting traces:

```bash
# Run Jaeger all-in-one locally
docker run -d --name jaeger \
  -p 16686:16686 \   # Jaeger UI
  -p 4318:4318 \     # OTLP HTTP receiver
  jaegertracing/all-in-one:latest
```

### PostgreSQL — Database Monitoring

PostgreSQL provides excellent built-in monitoring. However, most built-in views are **point-in-time snapshots or cumulative counters**, not time-series data. Understanding this distinction is important for deciding whether you need polling scripts or dedicated tooling.

#### Built-in Views: Historical vs. Point-in-Time

| View / Extension                                  | Data nature                                                    | Historical?                                            | Polling needed?                                                                                                                                                                | Notes                                                                                                        |
| :------------------------------------------------ | :------------------------------------------------------------- | :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| **`pg_stat_statements`**                          | **Cumulative** counters since last reset.                      | No — shows totals, not trends.                         | Yes, if you want time-series data (e.g., "queries/sec over time"). For post-hoc analysis ("what was the slowest query overall?"), a single query after the test is sufficient. | Reset before the load test with `SELECT pg_stat_statements_reset();` to get a clean window.                  |
| **`pg_stat_activity`**                            | **Live snapshot** of current connections and queries.          | No — shows only the current instant.                   | Yes — must poll to observe connection count over time.                                                                                                                         | Disappears the moment a query finishes. Only useful for real-time observation.                               |
| **`pg_stat_user_tables`**                         | **Cumulative** counters (seq_scan count, rows inserted, etc.). | No — same as `pg_stat_statements`.                     | Not needed — query once after the test for a total tally.                                                                                                                      | Reset is per-server restart. Delta between pre-test and post-test snapshots gives the test window's numbers. |
| **`pg_locks`**                                    | **Live snapshot**.                                             | No.                                                    | Yes — must poll to catch transient lock contention.                                                                                                                            | Locks are short-lived; a single query may miss them entirely.                                                |
| **Slow query log** (`log_min_duration_statement`) | **Append-only log file**.                                      | **Yes** — every slow query is logged with a timestamp. | No polling needed — analysis is post-hoc via the log file.                                                                                                                     | The best source of historical query data with zero custom scripting.                                         |

**Summary:** `pg_stat_statements` and `pg_stat_user_tables` give you _totals_ (useful after the test), not time-series. `pg_stat_activity` and `pg_locks` are live-only and require polling to capture transient states. The **slow query log** is the only built-in source that provides true historical, timestamped data without any custom scripting.

#### Do You Need Custom Polling Scripts?

**For Phase 1 (minimal), no.** The combination of:

1. Resetting `pg_stat_statements` before the test and querying it once after → gives you the top-N slowest queries.
2. Enabling `log_min_duration_statement` → gives you a timestamped log of every slow query.
3. Running pgBadger on the log → gives you a visual report.

...covers 90% of load test analysis without writing any polling code.

**For Phase 2 (time-series trends),** you have two options:

| Approach                                                        | Effort                                               | What it gives you                                                                                                                                                                                                                             |
| :-------------------------------------------------------------- | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`pg_stat_monitor`** (Percona)                                 | Low — install extension, configure bucket size.      | Drop-in replacement for `pg_stat_statements` that groups statistics into **configurable time buckets** (e.g., 60-second windows). Provides native time-series query stats without any external polling.                                       |
| [**pgwatch2**](https://github.com/cybertec-postgresql/pgwatch2) | Medium — run as a Docker container alongside the DB. | Continuously polls `pg_stat_statements`, `pg_stat_activity`, `pg_locks`, and other views. Stores results in InfluxDB or TimescaleDB. Visualizes via built-in Grafana dashboards. **This eliminates the need for any custom polling scripts.** |

**Recommendation:** For load testing on commodity hardware, start with `pg_stat_statements` + slow query log + pgBadger (Phase 1). If you find yourself needing "connection count over time" or "queries/sec over time" charts, adopt **pgwatch2** rather than writing custom polling scripts — it solves the problem out of the box with a single `docker-compose` service.

#### pg_stat_monitor vs. pg_stat_statements

If you want to stay within PostgreSQL extensions and avoid external polling entirely, **`pg_stat_monitor`** (developed by Percona) is a compelling alternative to `pg_stat_statements`:

| Feature            | `pg_stat_statements`           | `pg_stat_monitor`                                   |
| :----------------- | :----------------------------- | :-------------------------------------------------- |
| Data model         | Cumulative since last reset    | **Time-bucketed** (configurable, e.g., 60s windows) |
| Historical trends  | Requires external snapshotting | Built-in — each bucket is a time window             |
| Query plan capture | No                             | Yes — captures `EXPLAIN` plans                      |
| Client information | No                             | Yes — tracks application name, client IP            |
| Histograms         | No                             | Yes — response time distribution                    |
| Overhead           | Very low                       | Low (slightly higher than pg_stat_statements)       |

For load testing, `pg_stat_monitor`'s bucket-based model means you can answer "how did query latency change during the ramp-up phase?" directly from SQL, without external infrastructure. Configure the bucket size to match your test phases (e.g., 60-second buckets for a 10-minute test gives 10 data points per query).

```sql
-- Install (one-time)
CREATE EXTENSION pg_stat_monitor;

-- Configure 60-second buckets
ALTER SYSTEM SET pg_stat_monitor.pgsm_bucket_time = 60;
SELECT pg_reload_conf();

-- After the load test: view query latency per time bucket
SELECT bucket_start_time, query, calls, mean_exec_time, max_exec_time
FROM pg_stat_monitor
ORDER BY bucket_start_time, mean_exec_time DESC;
```

#### Query Logging for Post-Hoc Analysis

The slow query log is the simplest and most reliable source of historical query data. Enable it during load tests:

```sql
-- Log queries slower than 100ms
ALTER SYSTEM SET log_min_duration_statement = 100;
SELECT pg_reload_conf();
```

For the dev Docker Compose setup, add these to the `command` flags:

```yaml
command: "postgres -c 'shared_preload_libraries=pg_stat_statements' -c 'log_min_duration_statement=100'"
```

After the test, analyze the PostgreSQL log with [**pgBadger**](https://pgbadger.darold.net/) to get a report of query frequencies, slowest queries, and lock wait times. pgBadger is a Perl script that parses PostgreSQL logs — no database-side installation needed.

#### Connection Pool Monitoring

Prisma uses a connection pool. Monitor pool saturation by checking:

- `pg_stat_activity` connection counts vs. the Prisma pool size (`connection_limit` in the Prisma datasource URL). If using pgwatch2, this is tracked and graphed automatically.
- Prisma client-side metrics (if enabled): Prisma supports a `metrics` preview feature that exposes `prisma_pool_connections_open`, `prisma_pool_connections_busy`, and `prisma_client_queries_wait` gauges.

### Redis — Queue and Rate Limiter Monitoring

#### Built-in Commands (No External Tools)

| Command                           | What it provides                                                                                         | How to use                                                                                                                                                                   |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`redis-cli INFO stats`**        | Total commands processed, keyspace hits/misses, connected clients, memory usage.                         | Run periodically during the test (or log via a script every 5s). Watch `instantaneous_ops_per_sec` and `connected_clients`.                                                  |
| **`redis-cli INFO memory`**       | Detailed memory breakdown: used memory, peak memory, fragmentation ratio.                                | Check that `used_memory` is not growing unboundedly (indicating queue jobs are not being consumed).                                                                          |
| **`redis-cli INFO clients`**      | Connected clients, blocked clients, max client input/output buffer sizes.                                | `blocked_clients > 0` indicates BullMQ workers waiting for jobs (normal), but `connected_clients` approaching `maxclients` is a problem.                                     |
| **`LLEN bull:<queue-name>:wait`** | Pending job count for a BullMQ queue.                                                                    | The most direct measure of queue backpressure. If `LLEN` grows monotonically during the test, workers cannot keep up. Poll this every 5–10s.                                 |
| **`redis-cli --latency`**         | Continuous round-trip latency measurement.                                                               | Run from the application machine to the Redis host during the test. Baseline should be sub-millisecond on localhost. Spikes indicate Redis CPU saturation or network issues. |
| **`redis-cli SLOWLOG GET 20`**    | Lists the 20 most recent commands that exceeded the `slowlog-log-slower-than` threshold (default: 10ms). | Check after the test for commands that are unexpectedly slow (e.g., large `LRANGE` operations).                                                                              |

#### Queue-Specific Monitoring

BullMQ exposes job lifecycle counts that can be queried via the `Queue` class in Node.js:

```typescript
const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed")
```

During load tests, log these counts periodically (e.g., every 10s) from a monitoring script or from within the worker process itself. Key signals:

- **`waiting` growing faster than `completed`** → worker throughput is insufficient.
- **`failed` count climbing** → worker errors under load (connection timeouts, OCC failures exhausting retries).
- **`active` at the concurrency limit for extended periods** → worker is saturated.

### Monitoring Stack Summary

The table below summarizes the recommended monitoring approach, layered by complexity:

| Layer                  | Phase 1 (Minimal — Start Here)                                                   | Phase 2 (Structured)                            | Phase 3 (Production-Grade)                               |
| :--------------------- | :------------------------------------------------------------------------------- | :---------------------------------------------- | :------------------------------------------------------- |
| **Node.js process**    | `perf_hooks.monitorEventLoopDelay()`, `process.memoryUsage()`, `node --prof`     | 0x / `@platformatic/flame` (targeted profiling) | OpenTelemetry auto-instrumentation → Jaeger              |
| **Node.js code paths** | `node --prof` flamegraph, Chrome DevTools (`--inspect`)                          | 0x interactive flamegraphs                      | OpenTelemetry spans with Prisma + NestJS instrumentation |
| **PostgreSQL**         | `pg_stat_statements` (reset before test, query after), slow query log + pgBadger | `pg_stat_monitor` (time-bucketed, no polling)   | pgwatch2 → InfluxDB → Grafana                            |
| **Redis**              | `redis-cli INFO`, `LLEN`, `SLOWLOG`, `--latency`                                 | BullMQ `getJobCounts()` logged periodically     | `redis_exporter` → Prometheus → Grafana                  |
| **Correlation**        | Manual (timestamps in logs)                                                      | k6 JSON output + DB/Redis logs aligned by time  | OpenTelemetry traces spanning HTTP → DB → Redis          |

**Phase 1 requires zero additional dependencies.** All tools are either built into Node.js, PostgreSQL, or Redis, or are standalone CLI tools. This is the recommended starting point for load testing on commodity hardware.

## Tooling Recommendation

### k6 (Grafana k6)

[k6](https://k6.io/) is the recommended load testing tool for the following reasons:

- **JavaScript/TypeScript test scripts** — aligns with the team's existing language skills. No need to learn a DSL.
- **Open-loop execution model** — the `constant-arrival-rate` executor avoids coordinated omission by default.
- **Built-in metrics** — percentile latencies, throughput, error rates, and custom counters out of the box.
- **Threshold-based pass/fail** — tests can be configured to fail CI if p95 latency exceeds a threshold or error rate exceeds 1%.
- **Lightweight** — single Go binary, no JVM, no cluster. Runs comfortably on a developer machine.
- **Extensible** — custom metrics, lifecycle hooks (`setup`/`teardown` for seeding), and scenario composition.

**Alternatives considered:**

| Tool          | Reason for not choosing                                                                                                                                |
| :------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache JMeter | JVM-based, XML configuration, GUI-centric. Poor developer experience for a TypeScript team.                                                            |
| Locust        | Python-based. Good tool, but introduces a second language dependency.                                                                                  |
| Artillery     | JavaScript-based and capable, but less mature open-loop execution and weaker metrics pipeline than k6.                                                 |
| `autocannon`  | Node.js-based, excellent for micro-benchmarks, but lacks scenario composition, lifecycle hooks, and structured reporting for complex multi-step flows. |

## Test Script Structure

A k6 test script for Approvio should follow this structure:

```
load-tests/
├── scripts/
│   ├── seed.ts              # Setup: create org topology, users, tokens
│   ├── scenarios/
│   │   ├── workflow-crud.ts  # Create workflow → vote → check status
│   │   ├── read-heavy.ts     # List workflows, audit logs, templates
│   │   └── vote-contention.ts# Concurrent votes on same workflow
│   └── teardown.ts           # Cleanup (optional)
├── lib/
│   ├── auth.ts               # Token pool management
│   ├── data-gen.ts           # Synthetic payload generators
│   └── checks.ts             # Response validation helpers
├── config/
│   ├── smoke.json            # 1 VU, 30s — sanity check
│   ├── baseline.json         # 10 VU, 5min — establish baseline
│   └── stress.json           # 50+ VU, 10min — find breaking point
└── README.md
```

### Execution Profiles

| Profile      | Purpose                                         | VUs           | Duration  | Arrival rate      |
| :----------- | :---------------------------------------------- | :------------ | :-------- | :---------------- |
| **Smoke**    | Verify the test script works                    | 1             | 30s       | N/A (closed-loop) |
| **Baseline** | Establish reference numbers on current hardware | 10            | 5 min     | 20 req/s          |
| **Stress**   | Find the breaking point                         | 50–200 (ramp) | 10 min    | 50–200 req/s ramp |
| **Soak**     | Detect memory leaks, connection pool exhaustion | 10            | 30–60 min | 20 req/s          |

## Regression Detection on Commodity Hardware

Since absolute numbers are unreliable, use a **relative regression** approach:

1. **Run the baseline profile before and after a code change** on the same machine, same seed data, same conditions.
2. **Compare p95 and p99 latencies and throughput.** A degradation of >15–20% is a signal worth investigating.
3. **Automate in CI (optional future step):** Run the smoke profile in CI as a gate. It won't catch subtle regressions, but it catches catastrophic ones (e.g., a missing index causing a full table scan).
4. **Track results over time.** Store k6 JSON output in a shared location (even a Git-tracked file). Plotting trends over multiple runs smooths out noise.

## Future Extensions

- **Grafana dashboards:** k6 can stream real-time metrics to Grafana via InfluxDB or Prometheus remote-write. This provides live dashboards during load tests.
- **CI integration:** Run the smoke profile on every PR. Run the baseline profile on merge to main (nightly).
- **Production-like environment:** When a staging environment becomes available, run stress and soak profiles against it for more reliable absolute numbers.
- **Distributed load generation:** k6 supports distributed execution via `k6-operator` (Kubernetes) for generating load beyond a single machine's capacity.

## References

- [k6 — Grafana Load Testing](https://k6.io/)
- [k6 Executors — Open vs. Closed Loop](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/)
- [Gil Tene — How NOT to Measure Latency (Coordinated Omission)](https://www.youtube.com/watch?v=lJ8ydIuPFeU)
- [ADR-004 — Audit Log Index Strategy](./004-audit-log-index-strategy.md)
- [ADR-005 — Load-Shedding Levers](./005-load-shedding-levers.md)
