# Task 4.4: Admission Resilience Levers & Cache Recomputation

## Context & Objective
Introduce operational incident levers and cache recomputation capabilities for the quota admission subsystem. When the primary admission cache suffers an outage, degradation, or dual-write desynchronization, operators require runtime levers to control system behavior (fail-closed vs. fail-open) and a mechanism to reconcile or rebuild cache counters from the durable PostgreSQL ledger.

- **Target Repository:** `/workspace/approvio` (`app/services`, `app/external`, `app/controllers`)
- **Dependencies:** Task 3.2 (UsageMeteringService), Task 2.3 (PostgresUsageEventRepository), ADR 005 (Load Shedding Levers)

---

## Coding Guidelines & Constraints
- Adhere to established Approvio NestJS service patterns.
- Follow fp-ts conventions (`TaskEither`, no `as Type` casting).
- Integrate with Approvio's existing `LeverConfig` / `ConfigProvider` patterns.
- Ensure all cache recomputation queries against `usage_events` are strictly scoped by `orgId`, `metric`, and billing `period` boundaries using appropriate database indexes.

---

## Technical Specifications

### 1. Operational Incident Levers (`LeverConfig`)
Extend the application lever configuration to govern admission behavior during cache dependency degradation:

```typescript
export interface UsageAdmissionLeverConfig {
  /**
   * Admission policy when the fast admission cache is unreachable or errors.
   * - "FAIL_CLOSED" (Default): Rejects admission with quota error to prevent unmetered over-consumption.
   * - "FAIL_OPEN": Admits invocations by default during incident mitigation to maintain customer execution.
   */
  readonly cacheFailurePolicy: "FAIL_CLOSED" | "FAIL_OPEN"

  /**
   * Emergency lever to suppress in-flight capacity reservations.
   * When true, `admitAndReserve` checks current consumption without holding reservation balance.
   */
  readonly suppressReservations: boolean

  /**
   * Emergency fallback to evaluate pre-flight limits directly against PostgreSQL ledger sums
   * when the admission cache is offline.
   */
  readonly ledgerFallbackEnabled: boolean
}
```

### 2. UsageMeteringService Lever Integration
Update `admitAndReserve` in `UsageMeteringService`:
- If `admissionClient.reserve` fails and `cacheFailurePolicy === "FAIL_OPEN"`, log a warning and return `TE.right(undefined)`.
- If `suppressReservations === true`, bypass the capacity reservation increment.
- If `ledgerFallbackEnabled === true`, query `usageEventRepo.getPeriodTotal(orgId, metric, periodStartsAt, periodEndsAt)` to evaluate limits directly against durable history.

### 3. Cache Recomputation & Reconciliation Service
Implement `UsageCacheReconciliationService`:
- **Function:** `recomputeOrganizationCache(orgId: string, metric: UsageMetric, period: string): TaskEither<ReconciliationError, RecomputeResult>`
- **Workflow:**
  1. Computes `periodStartsAt` and `periodEndsAt` from `parseBillingPeriod(period)`.
  2. Executes an indexed aggregate query on PostgreSQL:
     ```sql
     SELECT COALESCE(SUM(quantity), 0) AS total_consumed
     FROM usage_events
     WHERE org_id = :orgId
       AND metric = :metric
       AND occurred_at >= :periodStartsAt
       AND occurred_at <= :periodEndsAt;
     ```
  3. Overwrites/resets the admission cache key:
     - `HSET usage:{orgId}:{metric}:{period} consumed <total_consumed>`
     - Clears or resets `reserved` to `0`.
- **Administrative Endpoint / CLI Command:**
  - `POST /admin/organizations/:orgId/usage/recompute` (Admin-only) or scheduled reconciliation task.

---

## Exit Criteria
1. Integration tests verify `FAIL_OPEN` and `FAIL_CLOSED` behavior under simulated cache disconnections.
2. Integration tests verify `recomputeOrganizationCache` accurately restores Redis counters from PostgreSQL `usage_events` rows.
3. `yarn build` and `yarn test` pass with zero regressions.
