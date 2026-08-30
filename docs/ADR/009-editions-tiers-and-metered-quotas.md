# ADR 009: Deployment Editions, Subscription Tiers, and Metered Quota Governance

**Context / Scope:** Cross-System Architecture (`approvio`, `approvio-api`, `approvio-frontend`)

---

## 1. Context and Problem Statement

As Approvio expands from deterministic approval workflows into resource-intensive capabilities (such as **Native AI Evaluators**, automated compliance engines, external webhook dispatchers, and heavy data verifications), the platform faces three core architectural challenges:

1. **Deployment Edition Variance (Self-Hosted vs. SaaS Cloud):**
   - **Self-Hosted:** Customers run on their own infrastructure, manage their own compute, and supply external credentials (BYOK LLM keys, internal VPC endpoints).
   - **SaaS Cloud:** Approvio hosts multi-tenant infrastructure, manages compute, and provides shared platform LLM connections where inference costs are incurred directly by the business.
   - The platform needs a clean boundary for feature parity, technical differences, and commercial entitlements without codebase fragmentation.

2. **Cost Governance & Quota Classifications:**
   Resource-heavy and AI-driven features introduce variable operational costs. Quotas across the system serve three distinct purposes:
   - **Monetization & Service Levels (Cardinality limits):** Limits on static resources (spaces, groups, templates) to differentiate subscription tiers. For these non-monetary entity counts, minor race conditions under concurrent creation (e.g. creating 11 spaces against a limit of 10) are acceptable to avoid complex row locks and serialization bottlenecks.
   - **System Health & Technical Guardrails (Concurrency limits):** Guardrails on active operations (concurrent workflows, webhook throughput) to prevent noisy-neighbor degradation.
   - **Direct Financial Cost Protection (Consumption meters):** Hard financial limits on platform-managed LLM tokens and billed compute. Runaway loops generate direct cloud costs, making strict pre-flight admission, token reservations, and settlement non-negotiable.

3. **Multi-Tenancy, Actor Attribution, and Metering Durability:**
   - The existing system uses a single global organization (`DEFAULT_ORG_ID`). Multi-tenancy requires supporting personal organizations (B2C signup) and team/enterprise organizations (B2B).
   - Redis counters provide sub-millisecond admission gating for serverless runtimes, but Redis is not a durable system of record. Billing, dispute resolution, audit trails, and customer dashboards require a durable, event-based usage ledger in PostgreSQL.
   - Approvio treats both human **Users** and autonomous **Agents** as first-class actors; attribution must record the specific principal triggering consumption.

---

## 2. In-Depth Analysis of Architectural Dimensions

### 2.1 Deployment Editions vs. Commercial Entitlements

Companies operating dual-delivery models (Self-Hosted + SaaS) typically follow one of three paths:

| Model | Description | Examples | Trade-offs |
| :--- | :--- | :--- | :--- |
| **1. 100% Feature Parity + Contract/Fair-Source (Chosen)** | Single open codebase. Core features work everywhere. Cloud differs only where infrastructure requires it (e.g., managed proxy vs. local BYOK). Commercial terms enforced by contract/license. | PostHog (early), Grafana, Metabase | Maximizes developer adoption; eliminates branch drift. Enterprise self-hosted compliance relies on license agreements. |
| **2. Core + Proprietary Extensions (Open Core)** | Separate public and enterprise plugins unlocked by signed license keys. | GitLab (CE vs EE), Mattermost | Strong technical license enforcement. High CI/CD and repository maintenance overhead. |
| **3. SaaS-Exclusive Feature Forking** | High-value features withheld from self-hosted builds to drive cloud conversions. | Sentry (select AI/alerting tools), Supabase Cloud | Drives SaaS revenue. Frustrates open-source community; risks community forks. |

#### Decoupling Edition from Entitlements
To keep the codebase maintainable, we separate infrastructure packaging from commercial rights:
- **Deployment Edition (`DEPLOYMENT_EDITION`):** `self_hosted` or `saas_cloud`. Determines infrastructure configuration and service wiring.
- **Entitlement Source:** `default`, `subscription`, `license`, or `override`. Determines which features and limits apply to a subject.

```typescript
// Domain code checks only the effective entitlement
const decision = await featureGateService.isFeatureEnabled(
  FeatureKey.PLATFORM_LLM_EVALUATORS,
  { orgId, actorId }
);
```

In `self_hosted` mode, all features default to enabled. If commercial requirements later dictate signed enterprise license keys for on-premise deployments, the check is added inside `FeatureGateService` without modifying workflow or domain logic.

---

### 2.2 Quota Taxonomy and Enforcement Strategies

Quotas are classified into three functional families:

| Quota Family | Primary Objective | Concurrency Tolerance | Enforcement Mechanism | Failure Mode |
| :--- | :--- | :--- | :--- | :--- |
| **Cardinality** (e.g. `MAX_SPACES`, `MAX_GROUPS`) | Tier differentiation / Monetization | **Soft:** Minor surplus (e.g., 1-2 extra entities) under high write concurrency is accepted to avoid DB locking. | Synchronous SQL `COUNT` check before `INSERT`. | Block creation (`quota_exceeded`) |
| **Concurrency** (e.g. `MAX_CONCURRENT_WORKFLOWS`) | System stability / Noisy-neighbor protection | **Moderate:** Short-lived bursts tolerated; sustained over-subscription rejected. | Redis distributed semaphore / active execution counter. | Reject execution or queue with backoff |
| **Metered Consumption** (e.g. `MAX_LLM_TOKENS_PER_MONTH`) | Direct financial cost protection | **Strict:** Zero over-allocation allowed for platform-billed resources. | Redis atomic reservation + settlement lifecycle. | Immediate rejection before external API call |

#### Entitlement Resolution Hierarchy
Quota limits resolve through a deterministic hierarchy:

$$\text{Resource Override} \;\longrightarrow\; \text{Org Override} \;\longrightarrow\; \text{Tier Baseline} \;\longrightarrow\; \text{Configured Unlimited} \;\Big|\; \text{Fail-Closed Error}$$

- **Fail-Closed Semantics:** If a quota definition is missing from the active tier configuration, the system rejects the operation and logs a configuration error. An unknown quota never defaults to unlimited.
- **Operational Continuity on Downgrade:** Existing entities, read operations, audit exports, and historical workflows are never deleted or locked when a plan downgrades. Only new resource creation and new metered invocations are gated.

---

### 2.3 Metered Usage Architecture: Fast Admission vs. Durable Ledger

#### Technology Comparison for Usage Tracking

| Architecture | Gating Latency | Scale-to-Zero Safe? | Audit & Billing Integrity | Operational Complexity |
| :--- | :--- | :--- | :--- | :--- |
| **A. In-Memory Batch + Flush** | $<0.1\text{ ms}$ | ❌ **No** (data loss on container termination) | Poor (uncommitted events lost on freeze) | Low |
| **B. PostgreSQL Synchronous Upserts** | $10 - 30\text{ ms}$ | ✅ **Yes** | High (transactional ACID) | High row-lock contention under workflow bursts |
| **C. Redis Hashes as System of Record** | $<1.0\text{ ms}$ | ✅ **Yes** | Low (lossy on eviction/restart; no audit replay) | Low |
| **D. Dedicated Metering Cluster (OpenMeter/Lago)** | $10 - 50\text{ ms}$ | ✅ **Yes** | Very High | Overkill for current deployment topology (requires Kafka/ClickHouse) |
| **E. Hybrid: Redis Admission + PostgreSQL Ledger (Chosen)** | $<1.0\text{ ms}$ | ✅ **Yes** | High (durable events in DB, fast gate in Redis) | Moderate (standard Redis + existing PostgreSQL) |

#### Separation of Concerns
1. **Redis (Fast Admission & Reservation):** Tracks active billing period consumption and holds pending reservations. Answers: *"Can this tenant execute right now?"*
2. **PostgreSQL (Durable Usage Ledger):** Stores immutable `usage_events` records. Answers: *"What did this tenant consume, when, and by which actor?"* Used for invoice reconciliation, usage dashboards, billing exports, and dispute audits.

---

### 2.4 Metered Pricing Units: Tokens, Evaluations, and Model Cost Multipliers

When gating platform LLM features, three metering models are available:

1. **Direct Compute Metering (`MAX_LLM_TOKENS_PER_MONTH`):**
   - **Characteristics:** Tracks actual input/output token consumption.
   - **Trade-offs:** Directly matches underlying provider costs, protecting gross margins. However, raw token numbers are harder for non-technical buyers to predict and reason about.
2. **Call-Based Metering (`MAX_EVALUATIONS_PER_MONTH`):**
   - **Characteristics:** Tracks discrete evaluation invocations ($+1$ per evaluation).
   - **Trade-offs:** Highly intuitive to market (e.g., *"1,000 evaluations/month"*). However, it exposes the platform to financial risk if prompt payloads or reasoning steps vary widely.
3. **Credit / Multiplier Proxy Metering (`MAX_CREDITS_PER_MONTH`):**
   - **Characteristics:** Tenants receive a monthly credit pool. Each evaluation or token batch consumes credits weighted by the selected model's cost multiplier (e.g., a fast lightweight model costs $1\times$ credits per call/token, while a frontier reasoning model costs $10\times$).
   - **Trade-offs:** Combines the marketing clarity of a single visible metric ("10,000 credits/mo") with backend cost protection across heterogeneous LLM providers and models.

#### Unified Metering Strategy
The metering engine will support all three metrics through the same underlying reservation engine:
- **Foundational Architecture:** Redis reservations and PostgreSQL event ledgers track raw token counts and weighted cost units.
- **Commercial Flexibility:** Subscription tiers can define limits in raw tokens, evaluation calls, or weighted credits.
- **Phased Validation:** During the Native Evaluators implementation, we will benchmark prompt sizes across supported model tiers to decide whether to expose direct tokens, simple evaluations with internal token ceilings, or model-weighted credits on public pricing tiers.

#### Variable Token Lifecycle: Reservation and Settlement
Because token counts are only known after the provider responds, variable operations follow a three-stage lifecycle:

```
                  ┌───────────────────────────────┐
                  │ 1. ADMIT & RESERVE            │
                  │ Check: consumed + reserved    │
                  │        + estimate <= limit    │
                  │ HINCRBY reserved estimate     │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                  ┌───────────────────────────────┐
                  │ 2. EXECUTE OPERATION          │
                  │ Call LLM Provider (BYOK /     │
                  │ Managed Connection)           │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                  ┌───────────────────────────────┐
                  │ 3. SETTLE & RECORD            │
                  │ - Deduct estimate from reserve│
                  │ - HINCRBY consumed actual     │
                  │ - INSERT INTO usage_events    │
                  └───────────────────────────────┘
```

If the operation fails, times out, or is cancelled, the reserved capacity is released immediately.

---

### 2.5 Multi-Tenancy, Actor Attribution, and Billing Scopes

1. **Billing Periods vs. Calendar Months:**
   Redis quota keys are scoped by billing period ID rather than static calendar months:
   ```
   usage:{orgId}:{metric}:{billingPeriodId}
   ```
   This handles mid-cycle upgrades, trial periods, and annual subscription cycles without key collisions. For self-hosted instances without external billing subscriptions, `billingPeriodId` defaults to the standard calendar format (`YYYY-MM`).

2. **Actor Model (Users and Agents):**
   Approvio supports both human users and autonomous agents. Usage events record the principal type:
   - `actor_type`: `USER`, `AGENT`, or `SERVICE_ACCOUNT`
   - `actor_id`: UUID of the invoking entity

3. **BYOK vs. Platform-Managed Metering:**
   - **Platform-Managed Keys:** Approvio incurs direct financial cost $\rightarrow$ Billable, strict pre-flight reservation and hard quota cutoff.
   - **Customer BYOK:** Customer pays their provider directly $\rightarrow$ Non-billable to Approvio, but still metered for rate limiting, operational observability, and fair-share dashboards.

---

## 3. Decision

We will implement a unified **Entitlement, Tiering, and Serverless-Ready Metered Quota Architecture**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Incoming Workflow Request                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │       Feature Gate Service        │
                     │ (Edition & Tier Entitlements)     │
                     └─────────────────┬─────────────────┘
                                       │ Allowed
                                       ▼
                     ┌───────────────────────────────────┐
                     │      Resource Quota Engine        │
                     └─────────────────┬─────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
   ┌───────────────────────────┐               ┌───────────────────────────┐
   │   Instantaneous Quotas    │               │  Metered Windowed Quotas  │
   │ (Spaces, Templates, etc)  │               │ (Platform LLM Tokens/Runs)│
   ├───────────────────────────┤               ├───────────────────────────┤
   │ Scope: Cardinality        │               │ Scope: Consumption        │
   │ Resolution:               │               │ Two-Tiered Enforcement:   │
   │ Custom -> Org Override -> │               │ 1. Redis: Fast Admission  │
   │ Tier Default -> FailClose │               │    (Reserved + Consumed)  │
   │ Enforcement: SQL COUNT    │               │ 2. PostgreSQL: Ledger     │
   │ (Accepts soft race cond)  │               │    (usage_events table)   │
   └───────────────────────────┘               └───────────────────────────┘
```

### 3.1 100% Feature Parity & Edition Abstraction
1. **Unified Codebase:** Both Self-Hosted and SaaS Cloud run from the identical codebase and container images.
2. **Decoupled Packaging:** `DEPLOYMENT_EDITION` (`self_hosted` vs. `saas_cloud`) configures infrastructure wiring. Commercial rights and feature limits are resolved exclusively via `FeatureGateService`.
3. **Open Baseline:** In `self_hosted` mode, all features default to enabled with zero artificial throttling. Future enterprise on-premise licensing checks can plug directly into `FeatureGateService` without modifying domain code.

### 3.2 Tier Baseline & Resolution Hierarchy
1. **Hierarchical Quota Resolution:** `Resource Override -> Org Override -> Tier Baseline Default`.
2. **Fail-Closed Configuration:** If a quota definition is missing from the active tier, the system denies the operation and logs a configuration error. Missing quotas never default to unlimited.
3. **Non-Destructive Downgrades:** Plan downgrades or quota exhaustion never delete or lock existing entities or workflows; they only gate new entity creation and new metered execution.

### 3.3 Hybrid Metering Architecture
1. **Fast Admission Layer (Redis):** Stateless compute instances perform atomic pre-flight checks against in-memory counters (`consumed` and `reserved`) keyed by billing period.
2. **Durable Ledger Layer (PostgreSQL):** Completed operations record immutable events in the `usage_events` table for invoice reconciliation, audit trails, and reporting dashboards.
3. **Reservation & Settlement Lifecycle:** Variable-usage operations (e.g. LLM tokens) reserve estimated capacity upfront, perform the provider call, and settle the actual consumed amount while releasing unused capacity.
4. **Flexible Metric Models:** The engine natively supports compute tokens, call counts, and model-weighted credit proxies under the same reservation lifecycle.

---

## 4. Consequences and Trade-offs

### Positive Consequences
- **Margin & Financial Protection:** Atomic reservation prevents runaway LLM costs under high multi-tenant concurrency.
- **Audit & Billing Integrity:** Immutable PostgreSQL ledger guarantees auditable billing data, dispute resolution, and historical analytics independent of transient Redis cache lifecycles.
- **Zero-State Serverless Compatibility:** Operates seamlessly across containerized workers and scale-to-zero serverless functions without local in-memory batching risk.
- **Polymorphic Identity Support:** Usage attribution tracks both human `User` and autonomous `Agent` principals uniformly.
- **Low Mutation Overhead:** Retaining lightweight SQL counts for static cardinality quotas avoids database lock contention.

### Trade-offs and Mitigations
- **Operational Dependency on Redis:** SaaS deployments require a managed Redis instance for admission control (already utilized by BullMQ workers in self-hosted mode).
- **Ledger Storage Growth:** High-volume event writes in PostgreSQL require time-based table partitioning and periodic asynchronous aggregation for historical periods.
- **Dangling Reservation Risk:** Instance termination during an inflight LLM call could leave reserved capacity held.
  - *Mitigation:* Inflight reservations include expiration TTLs and are reconciled by background health sweeps.

---

## Appendix A: Redis Memory Sizing & Capacity Estimation (Architectural Estimate)

To evaluate the operational RAM footprint of Redis for fast admission control, we model an order-of-magnitude sizing estimate under multi-tenant scale:

### 1. Key and Field Structure
- **Key Pattern:** `usage:{orgId}:{metric}:{billingPeriodId}` ($\approx 80 \text{ bytes}$)
- **Fields per Key:**
  - `consumed`: 64-bit integer ($\approx 16 \text{ bytes}$)
  - `reserved`: 64-bit integer ($\approx 16 \text{ bytes}$)

### 2. Overhead Breakdown (Redis 7/8 / listpack encoding)
In Redis $\ge 7.0$, hashes with entries $\le 512$ (`hash-max-listpack-entries`) are encoded as compact listpacks:
- Listpack buffer per entry: $\approx 35 \text{ bytes}$
- Hash header and key metadata: $\approx 48 \text{ bytes}$
- Dict entry and pointer overhead: $\approx 24 \text{ bytes}$
- **Estimated total RAM per active metric hash:** $\approx 250 - 350 \text{ bytes}$

### 3. Tenant Scale Estimations (Active Metrics = 5 per Organization)

| Active Organizations | Active Monthly Hashes | Baseline Hash RAM | RAM with Allocator Fragmentation ($1.4\times$) |
| :--- | :--- | :--- | :--- |
| **1,000 Orgs** | 5,000 hashes | $\approx 1.5 \text{ MB}$ | $\approx 2.1 \text{ MB}$ |
| **10,000 Orgs** | 50,000 hashes | $\approx 15.0 \text{ MB}$ | $\approx 21.0 \text{ MB}$ |
| **100,000 Orgs** | 500,000 hashes | $\approx 150.0 \text{ MB}$ | $\approx 210.0 \text{ MB}$ |

Even at **100,000 active organizations** tracking 5 metered metrics across overlapping billing cycle keys, the estimated Redis RAM requirement remains **$\approx 200 - 300 \text{ MB}$**, fitting comfortably within entry-level managed Redis instances (e.g., 1 GB node). Exact memory usage should be monitored and verified with production load benchmarks.
