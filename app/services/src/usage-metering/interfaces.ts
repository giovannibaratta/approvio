import {QuotaGetError} from "../quota/interfaces"
import {
  BoundaryError,
  UsageEvent,
  UsageEventValidationError,
  OriginatingActor,
  MetricUnit,
  TenantContext,
  UsageQuotaLimit,
  UsageEntity,
  UsageMetric,
  TenantEventValidationError
} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {UsageError} from "../durable-work/interfaces"
export type {UsageOperationValidationError} from "../durable-work/models"
import {AuthorizationError, UnknownError} from "../error"
import {OrganizationPlanTierError} from "../tenancy/interfaces"
import {UsageCacheSnapshot} from "./usage-cache-snapshot"
import {UsageCacheReservation, UsageCacheSettlement} from "./usage-cache-operation"

export interface ReservationResult {
  readonly consumed: bigint
  readonly reserved: bigint
}

export interface UsageCacheRecoveryRequest extends TenantContext {
  readonly metric: UsageMetric
  readonly period: string
}

export type QuotaAdmissionError =
  | "admission_error"
  | "invalid_response"
  | "operation_mismatch"
  | "cache_unavailable"
  | "rebuild_lease_lost"
  | "invalid_usage_data"
  | "usage_cache_inconsistent"
  | "operation_expired"

export interface QuotaAdmissionClient {
  /** Claims an empty/unready cache; a competing rebuild fails closed until its lease expires. */
  beginRebuild(key: string, owner: string): TE.TaskEither<QuotaAdmissionError, "ready" | "claimed" | "busy">
  /**
   * Installs totals and replay markers together only while the caller owns an unexpired rebuild lease.
   * Retention applies to terminal facts; outstanding reservations must keep the key alive.
   */
  restore(key: string, owner: string, snapshot: UsageCacheSnapshot): TE.TaskEither<QuotaAdmissionError, void>
  reserveOperation(
    key: string,
    reservation: UsageCacheReservation
  ): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult>

  applySettlement(key: string, settlement: UsageCacheSettlement): TE.TaskEither<QuotaAdmissionError, bigint>

  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: bigint; reserved: bigint}>
}

/**
 * Represents aggregated usage consumption for an individual actor.
 */
export interface ActorUsageSummary {
  /** The actor (user or agent) associated with the consumed units. */
  readonly actor: OriginatingActor
  /** Total quantity consumed by this actor for the queried metric within the date window. */
  readonly totalQuantity: bigint
}

/**
 * Repository interface for persisting immutable usage events and querying historical usage aggregations.
 */
export interface UsageEventRepository {
  /** Reads immutable ledger entries matching the supplied operation event identities. */
  getLedgerEntries(
    context: TenantContext,
    metric: UsageMetric,
    ids: ReadonlyArray<string>
  ): TE.TaskEither<UnknownError | BoundaryError, ReadonlyArray<Pick<UsageEvent, "id" | "quantity">>>

  /**
   * Persists a single immutable usage event.
   *
   * @param event - The usage event payload to persist.
   */
  persist(event: UsageEvent): TE.TaskEither<UnknownError | BoundaryError, void>

  /** Insert once by event identity and return the stored event for domain replay validation. */
  getOrCreateById(
    event: UsageEvent
  ): TE.TaskEither<UnknownError | BoundaryError | UsageEventValidationError, UsageEvent>

  /**
   * Persists a batch of immutable usage events in a single operation.
   *
   * @param events - Array of usage event payloads to persist.
   */
  persistBatch(events: UsageEvent[]): TE.TaskEither<UnknownError | BoundaryError, void>

  /**
   * Calculates the total aggregate quantity consumed for a metric within the specified date window [fromDate, toDate].
   *
   * @param metric - The usage metric to sum (e.g., MAX_LLM_TOKENS_PER_MONTH).
   * @param fromDate - Start date boundary (inclusive).
   * @param toDate - End date boundary (inclusive).
   * @returns Total consumed quantity as a bigint (0n if no records exist).
   */
  getPeriodTotal(
    context: TenantContext,
    metric: UsageMetric,
    fromDate: Date,
    toDate: Date
  ): TE.TaskEither<UnknownError | BoundaryError, bigint>

  /**
   * Aggregates usage for a metric grouped by individual actor within the specified date window [fromDate, toDate].
   *
   * @param metric - The usage metric to aggregate.
   * @param fromDate - Start date boundary (inclusive).
   * @param toDate - End date boundary (inclusive).
   * @returns Array of actor summaries containing each actor and their total consumed quantity.
   */
  getActorBreakdown(
    context: TenantContext,
    metric: UsageMetric,
    fromDate: Date,
    toDate: Date
  ): TE.TaskEither<UnknownError | BoundaryError, ActorUsageSummary[]>
}

export const USAGE_EVENT_REPOSITORY_TOKEN = Symbol("USAGE_EVENT_REPOSITORY_TOKEN")
export const QUOTA_ADMISSION_CLIENT_TOKEN = Symbol("QUOTA_ADMISSION_CLIENT_TOKEN")

/**
 * Parameters for pre-flight quota reservation.
 */
export interface AdmitAndReserveParams extends TenantContext {
  /** Trusted execution deadline, normally the workflow expiry. Checked before accessing Redis. */
  readonly expiresAt: Date
  readonly operationId: string
  readonly entity: UsageEntity
  readonly actor: OriginatingActor
  readonly metric: UsageMetric
  readonly estimatedUnits: bigint
  readonly period: string
  readonly isBillable?: boolean
}

/**
 * Parameters for post-operation quota settlement and immutable ledger entry.
 */
export interface SettleUsageParams extends AdmitAndReserveParams {
  readonly actualUnits: bigint
  readonly metadata?: Record<string, unknown>
}

/**
 * Parameters for releasing an inflight reservation.
 */
export interface CancelReservationParams extends TenantContext {
  readonly operationId: string
  readonly metric: UsageMetric
  readonly estimatedUnits: bigint
  readonly period: string
}

/**
 * Breakdown of consumption, active reservations, and remaining units for a single metric.
 */
export interface MetricUsageSummary {
  readonly metric: UsageMetric
  readonly limit: UsageQuotaLimit
  readonly consumed: bigint
  readonly reserved: bigint
  readonly remaining: UsageQuotaLimit
  readonly unit: MetricUnit
}

/**
 * Organization-wide usage summary for a specific billing period.
 */
export interface OrganizationUsageSummary extends TenantContext {
  readonly period: string
  readonly periodStartsAt: Date
  readonly periodEndsAt: Date
  readonly metrics: MetricUsageSummary[]
}

export type UsageMeteringError =
  | QuotaGetError
  | TenantEventValidationError
  | "event_not_found"
  | UsageError
  | QuotaAdmissionError
  | "invalid_actual_units"
  | "quota_exceeded"
  | "quota_cache_unavailable"
  | "quota_missing_configuration"
  | "billing_period_invalid_format"
  | "billing_period_invalid_month"
  | "billing_period_invalid_year"
  | "organization_not_found"
  | AuthorizationError
  | BoundaryError
  | UnknownError
  | OrganizationPlanTierError
  | "operation_mismatch"
  | "invalid_transition"
  | "invalid_usage"
  | "invalid_batch_size"
  | "repository_dependency_error"
  | "event_mismatch"
  | UsageEventValidationError
