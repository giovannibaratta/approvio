import {
  BoundaryError,
  CreateUsageEvent,
  OriginatingActor,
  MetricUnit,
  TenantContext,
  TierQuotaLimit,
  UsageEntity,
  UsageMetric,
  TenantEventValidationError
} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {UsageCacheSnapshot, UsageError, UsageSettlementResult} from "../durable-work/interfaces"
export type {UsageOperationValidationError} from "../durable-work/models"
import {AuthorizationError, UnknownError} from "../error"
import {OrganizationPlanTierError} from "../tenancy/interfaces"

export interface ReservationResult {
  readonly consumed: number
  readonly reserved: number
}

export interface UsageCacheRecoveryRequest extends TenantContext {
  readonly metric: UsageMetric
  readonly period: string
}

export type QuotaAdmissionError =
  | {readonly type: "admission_error"; readonly error: unknown}
  | {readonly type: "invalid_response"; readonly error: unknown}
  | {readonly type: "operation_mismatch"}
  | {readonly type: "cache_unavailable"}

export interface QuotaAdmissionClient {
  /** Claims an empty/unready cache; a competing rebuild fails closed until its lease expires. */
  beginRebuild(key: string, owner: string): TE.TaskEither<QuotaAdmissionError, "ready" | "claimed" | "busy">
  /**
   * Installs totals and replay markers together only while the caller owns an unexpired rebuild lease.
   * Retention applies to terminal facts; outstanding reservations must keep the key alive.
   */
  restore(
    key: string,
    owner: string,
    snapshot: UsageCacheSnapshot,
    retainUntil: Date
  ): TE.TaskEither<QuotaAdmissionError, void>
  reserveOperation(
    key: string,
    operationId: string,
    limit: TierQuotaLimit,
    estimate: number
  ): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult>

  applySettlement(
    key: string,
    operationId: string,
    revision: string,
    estimate: number,
    result: UsageSettlementResult
  ): TE.TaskEither<QuotaAdmissionError, number>

  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: number; reserved: number}>
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
  /**
   * Persists a single immutable usage event.
   *
   * @param event - The usage event payload to persist.
   */
  persist(context: TenantContext, event: CreateUsageEvent): TE.TaskEither<UnknownError | BoundaryError, void>

  persistOperation(
    context: TenantContext,
    operationId: string,
    event: CreateUsageEvent
  ): TE.TaskEither<UnknownError | BoundaryError | "event_mismatch", void>

  /**
   * Persists a batch of immutable usage events in a single operation.
   *
   * @param events - Array of usage event payloads to persist.
   */
  persistBatch(context: TenantContext, events: CreateUsageEvent[]): TE.TaskEither<UnknownError | BoundaryError, void>

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
  readonly operationId: string
  readonly entity: UsageEntity
  readonly actor: OriginatingActor
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly period: string
  readonly isBillable?: boolean
}

/**
 * Parameters for post-operation quota settlement and immutable ledger entry.
 */
export interface SettleUsageParams extends AdmitAndReserveParams {
  readonly actualUnits: number
  readonly metadata?: Record<string, unknown>
}

/**
 * Parameters for releasing an inflight reservation.
 */
export interface CancelReservationParams extends TenantContext {
  readonly operationId: string
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly period: string
}

/**
 * Breakdown of consumption, active reservations, and remaining units for a single metric.
 */
export interface MetricUsageSummary {
  readonly metric: UsageMetric
  readonly limit: TierQuotaLimit
  readonly consumed: number
  readonly reserved: number
  readonly remaining: TierQuotaLimit
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
