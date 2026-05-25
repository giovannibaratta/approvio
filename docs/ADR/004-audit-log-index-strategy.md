# ADR 004: Audit Log Index Strategy & Query Optimization

## Context and Problem Statement

Following the initial audit log table implementation (ADR 003), we analyzed the existing indexes against the actual query patterns in `audit-log.repository.ts` and the expected scaling trajectory. The analysis identified inefficiencies that should be corrected now, before the table accumulates significant data.

Key concerns:
- An index with no practical read benefit consuming write throughput on every insert.
- `COUNT(*)` queries that become a bottleneck at scale due to PostgreSQL's MVCC architecture.
- No time-based index to support range pruning on the immutable, time-ordered data.
- Need to define a sensible default retention window for the List API.

## Analysis Summary

### Current Indexes

| Index | Columns | Assessment |
|---|---|---|
| PK (`id`) | `id` | Necessary. UUIDv7 provides time-ordered, distributed-safe IDs. |
| `idx_audit_logs_actor_id_created_at` | `(actor_id, created_at DESC)` | Covers the `listMyAuditLogs` path. |
| `idx_audit_logs_entity_id_created_at` | `(entity_id, created_at DESC)` | Covers single-target entity queries. |
| `idx_audit_logs_entity_type` | `(entity_type)` | **Net negative.** Only 4 distinct values. PostgreSQL's optimizer will reject this index in favor of a sequential scan for any realistic dataset. Write overhead with no read benefit. |

### `COUNT(*)` Problem

PostgreSQL's MVCC requires `COUNT(*)` to walk every visible row matching the `WHERE` clause. There is no metadata shortcut.

No strategy (index-only counts, approximate counts, pre-computed counters) eliminates this cost for arbitrary filter combinations. Cursor-based pagination avoids the problem entirely.

### BRIN Index Opportunity

The table is append-only and `created_at` is monotonically increasing, making the physical heap order strongly correlated with time. A BRIN (Block Range INdex) on `created_at` provides:
- ~1000x smaller footprint than an equivalent B-Tree
- Near-zero insert overhead
- Effective block exclusion for time-range predicates

BRIN does not support `ORDER BY` or equality lookups — it complements existing B-Tree indexes by narrowing the scan scope when a `created_at` range is present in the `WHERE` clause.

## Decision

### 1. Drop `idx_audit_logs_entity_type`

Remove the standalone `entity_type` index. It has 4 distinct values, yielding ~25% selectivity — below the threshold where PostgreSQL would use it. Every insert pays the cost of maintaining this index with no query benefit.

### 2. Add BRIN index on `created_at`

This enables efficient block exclusion for the 7-day time-range filter on the API, at negligible storage and write cost.

### 3. Switch to cursor-based pagination

Replace `OFFSET/LIMIT` + `COUNT(*)` with keyset pagination:

```sql
SELECT * FROM audit_logs
WHERE ...
  AND (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $page_size;
```

The API response changes from `{items, total}` to `{items, hasMore, nextCursor}`. This provides O(1) pagination performance at any depth and eliminates the `COUNT(*)` bottleneck.

### 4. Limit the List API to the last 7 days

All audit log list queries will include a mandatory time-range filter scoped to the last 7 days. This:
- Bounds the maximum scan scope regardless of total table size.
- Enables the BRIN index to exclude all blocks outside the 7-day window.
- Prepares the architecture for future partitioning (time-range filters are required for partition pruning).

### Final Index Set

| Index | Columns | Type |
|---|---|---|
| PK (`id`) | `id` | B-Tree |
| `idx_audit_logs_actor_id_created_at` | `(actor_id, created_at DESC)` | B-Tree |
| `idx_audit_logs_entity_id_created_at` | `(entity_id, created_at DESC)` | B-Tree |
| `idx_audit_logs_created_at_brin` | `(created_at)` | BRIN |

## Future Extensions

- **Table Partitioning (Range by `created_at`):** When the table approaches 5M rows, introduce declarative range partitioning. The 7-day API limit ensures partition pruning will be effective.
- **Multi-Tenant Partitioning (`org_id`):** If multi-tenant support is introduced, consider LIST partitioning by `org_id` with time-based sub-partitions to achieve tenant isolation and per-tenant lifecycle management.
- **Tiered Data Access:** Use partition detachment to implement hot (7 days) / warm (30–90 days) / cold (batch export to S3/Parquet) data tiers.
