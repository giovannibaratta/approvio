import {Actor, CreateUsageEvent, MetricUnit, TierQuotaLimit, UsageEntity, UsageMetric} from "@domain"
import * as TE from "fp-ts/TaskEither"
import {AuthorizationError, UnknownError} from "../error"

export interface ReservationResult {
  readonly allowed: boolean
  readonly consumed: number
  readonly reserved: number
}

export type QuotaAdmissionError =
  | {readonly type: "admission_error"; readonly error: unknown}
  | {readonly type: "invalid_response"; readonly error: unknown}

export interface QuotaAdmissionClient {
  reserve(
    key: string,
    limit: number,
    estimate: number,
    ttlSeconds?: number
  ): TE.TaskEither<QuotaAdmissionError, ReservationResult>

  settle(key: string, estimate: number, actual: number): TE.TaskEither<QuotaAdmissionError, number>

  release(key: string, estimate: number): TE.TaskEither<QuotaAdmissionError, void>

  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: number; reserved: number}>
}

/**
 * Represents aggregated usage consumption for an individual actor.
 */
export interface ActorUsageSummary {
  /** The actor (user or agent) associated with the consumed units. */
  readonly actor: Actor
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
  persist(event: CreateUsageEvent): TE.TaskEither<UnknownError, void>

  /**
   * Persists a batch of immutable usage events in a single operation.
   *
   * @param events - Array of usage event payloads to persist.
   */
  persistBatch(events: CreateUsageEvent[]): TE.TaskEither<UnknownError, void>

  /**
   * Calculates the total aggregate quantity consumed for a metric within the specified date window [fromDate, toDate].
   *
   * @param metric - The usage metric to sum (e.g., MAX_LLM_TOKENS_PER_MONTH).
   * @param fromDate - Start date boundary (inclusive).
   * @param toDate - End date boundary (inclusive).
   * @returns Total consumed quantity as a bigint (0n if no records exist).
   */
  getPeriodTotal(metric: UsageMetric, fromDate: Date, toDate: Date): TE.TaskEither<UnknownError, bigint>

  /**
   * Aggregates usage for a metric grouped by individual actor within the specified date window [fromDate, toDate].
   *
   * @param metric - The usage metric to aggregate.
   * @param fromDate - Start date boundary (inclusive).
   * @param toDate - End date boundary (inclusive).
   * @returns Array of actor summaries containing each actor and their total consumed quantity.
   */
  getActorBreakdown(metric: UsageMetric, fromDate: Date, toDate: Date): TE.TaskEither<UnknownError, ActorUsageSummary[]>
}

export const USAGE_EVENT_REPOSITORY_TOKEN = Symbol("USAGE_EVENT_REPOSITORY_TOKEN")
export const QUOTA_ADMISSION_CLIENT_TOKEN = Symbol("QUOTA_ADMISSION_CLIENT_TOKEN")

/**
 * Parameters for pre-flight quota reservation.
 */
export interface AdmitAndReserveParams {
  readonly orgId: string
  readonly entity: UsageEntity
  readonly actor: Actor
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly period: string
  readonly isBillable?: boolean
}

/**
 * Parameters for post-operation quota settlement and immutable ledger entry.
 */
export interface SettleUsageParams {
  readonly orgId: string
  readonly entity: UsageEntity
  readonly actor: Actor
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly actualUnits: number
  readonly period: string
  readonly isBillable?: boolean
  readonly metadata?: Record<string, unknown>
}

/**
 * Parameters for releasing an inflight reservation.
 */
export interface CancelReservationParams {
  readonly orgId: string
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
export interface OrganizationUsageSummary {
  readonly orgId: string
  readonly period: string
  readonly periodStartsAt: Date
  readonly periodEndsAt: Date
  readonly metrics: MetricUsageSummary[]
}

export type UsageMeteringError =
  | "quota_exceeded"
  | "quota_missing_configuration"
  | "billing_period_invalid_format"
  | "billing_period_invalid_month"
  | "billing_period_invalid_year"
  | "organization_not_found"
  | AuthorizationError
  | UnknownError
