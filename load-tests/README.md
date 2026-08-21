# Approvio Load Tests

This directory contains the load testing suite for Approvio, based on the strategy defined in [ADR-007 Load Testing Strategy](../../docs/ADR/007-load-testing-strategy.md). It uses [k6](https://k6.io/) as the load generation tool.

## Architecture

The load testing framework is split into two phases:

1. **Seed Phase (`scripts/seed.ts`)**: A Node.js script that connects directly to the database via Prisma and the authentication system to pre-provision a realistic organizational topology (Orgs, Spaces, Groups, Templates, Users, Agents, and auth tokens). It outputs this topology to a `seed-data.json` file.
2. **Execution Phase (`scripts/scenarios/*.ts`)**: k6 scripts that simulate Virtual Users (VUs) interacting with the system. These scripts consume the `seed-data.json` file to know which endpoints to hit, which tokens to use, and which IDs to reference.

## Directory Structure

- `scripts/`: Entrypoints for test execution.
  - `seed.ts`: Setup script to generate test data.
  - `scenarios/`: Individual k6 test scripts.
    - `workflow-crud.ts`: Tests the core create-vote-check flow.
- `lib/`: Shared helper modules for k6 scripts.
  - `auth.ts`: Manages picking random pre-generated tokens.
  - `data-gen.ts`: Generates synthetic payloads (unique workflow names, etc).
  - `checks.ts`: Custom k6 response validation.
- `config/`: JSON files defining k6 execution profiles (VUs, duration, arrival rate).

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) must be installed locally.
- The Approvio backend API must be running.
- The Approvio PostgreSQL database must be accessible for the seed script.

## Running Tests

First, generate the seed data:

```bash
yarn load-test:seed
```

Then, run a test profile using the generic runner:

```bash
yarn load-test <config_name> <scenario_name>
```

For convenience, shortcuts for standard profiles are defined:

```bash
yarn load-test:smoke      # equivalent to: yarn load-test smoke workflow-crud
yarn load-test:baseline   # equivalent to: yarn load-test baseline workflow-crud
yarn load-test:stress     # equivalent to: yarn load-test stress workflow-crud
```

## Profiles

- **Smoke (`smoke.json`)**: Used to quickly verify that scripts, seed data, and target endpoints are functioning correctly.
- **Baseline (`baseline.json`)**: Sustained load to establishes reference latency/throughput baselines.
- **Stress (`stress.json`)**: Ramps up throughput over 10 minutes (up to 200 max VUs). Used to find the system's breaking point and resource limits.

## Configuration Concepts

k6 profiles are defined under `config/*.json` and configure how the test scenario generates load. Key concepts include:

### 1. Executors

An executor is the engine that drives the k6 run. We use different executors depending on the test profile:

- **`constant-vus`** (used in Smoke): A fixed number of Virtual Users run as many iterations as they can for a specified duration. This is a _closed-loop_ model where load generation depends on how fast the system under test responds.
- **`constant-arrival-rate`** (used in Baseline): k6 starts a fixed number of iterations (`rate`) per time unit (e.g., `1s`), dynamically scaling the number of VUs up to `maxVUs` as needed to maintain that rate. This is an _open-loop_ model, which prevents **coordinated omission** (where slow responses from a struggling system artificially lower the load generator's request rate).
- **`ramping-arrival-rate`** (used in Stress): Iterations are started at a changing rate that ramps up or down through defined stages.

### 2. Virtual Users (VUs)

VUs are concurrent, independent execution loops.

- In closed-loop executors (`constant-vus`), the VU count is fixed.
- In open-loop executors (`constant-arrival-rate`/`ramping-arrival-rate`), VUs are allocated dynamically up to `maxVUs` to sustain the target iteration start rate. We pre-allocate a starting number (`preAllocatedVUs`) to avoid initialization overhead during the test.

### 3. Rate & TimeUnit

Used by arrival-rate executors to specify the target throughput:

- **`rate`**: Number of iterations to start per time unit.
- **`timeUnit`**: The period for the target rate (typically `"1s"`).

### 4. Thresholds

Pass/fail criteria evaluated on metrics. For example:

- `http_req_failed`: The percentage of failed requests must remain under a threshold (e.g., `"rate<0.01"` for < 1% errors).
- `http_req_duration`: Latency percentiles (e.g., `"p(95)<1000"` meaning 95% of requests must complete in under 1000ms).

## Reading and Interpreting Results

At the end of a test run, k6 prints a summary report in the console and saves detailed outputs to `load-tests/report.html` and `load-tests/summary.json`. Here is how to understand and interpret key metrics:

### 1. Iterations vs. HTTP Requests

- **`iterations`**: Represents the execution of the main scenario function (`export default function() { ... }`). In our case, one iteration simulates a complete user journey (e.g., creating a workflow, fetching its status, and submitting a vote).
- **`iters/s` (or iteration rate)**: The number of completed user scenarios per second.
- **`http_reqs` (and request rate)**: The actual HTTP request rate (RPS). Because each iteration contains 3 HTTP requests (POST `/workflows` + GET `/workflows/{id}` + POST `/workflows/{id}/vote`), your **RPS is roughly `3 * iters/s`** (excluding retries/pre-flight checks).

### 2. Identifying Performance Bottlenecks

Look for these key indicators in the report to evaluate system health:

- **`dropped_iterations`**: If this number is greater than `0`, it means k6 tried to start new iterations to meet the target arrival rate (e.g., 20 iters/s) but was blocked because all VUs up to `maxVUs` were busy. This is a primary indicator that the backend is processing requests too slowly and has saturated the allocated VU pool.
- **`http_req_duration`**:
  - `med (median/p50)`: The middle response time (under typical conditions).
  - `p(95)` and `p(99)`: Tail latencies representing the worst-case 5% and 1% of requests. Spikes here indicate database locks, Node.js event-loop blocking, or queue delays.
- **`http_req_failed`**: The rate of HTTP requests that returned error status codes (5xx). Note that expected non-5xx errors under load (such as 409 OCC conflicts or 429 rate limits) are tracked separately from failed requests.
- **`http_req_waiting`**: Time spent waiting for the first byte of response (often server-side processing/database query execution time). If this dominates `http_req_duration`, the bottleneck is server-side CPU or database CPU/locking, not network transport.
