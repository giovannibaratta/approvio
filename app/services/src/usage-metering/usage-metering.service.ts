import {
  ALL_METERED_METRICS,
  AuthenticatedEntity,
  calculateRemainingQuota,
  formatBillingPeriod,
  getMetricUnit,
  OrgRole,
  parseBillingPeriod,
  resolveEffectiveLimit,
  UNLIMITED_QUOTA_SENTINEL,
  UsageMetric
} from "@domain"
import {ConfigProvider} from "@external/config"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {DEFAULT_ORG_ID} from "../constants"
import {validateUserEntity} from "../shared/types"
import {
  AdmitAndReserveParams,
  CancelReservationParams,
  MetricUsageSummary,
  OrganizationUsageSummary,
  QUOTA_ADMISSION_CLIENT_TOKEN,
  QuotaAdmissionClient,
  SettleUsageParams,
  USAGE_EVENT_REPOSITORY_TOKEN,
  UsageEventRepository,
  UsageMeteringError
} from "./interfaces"

@Injectable()
export class UsageMeteringService {
  constructor(
    @Inject(QUOTA_ADMISSION_CLIENT_TOKEN)
    private readonly admissionClient: QuotaAdmissionClient,
    @Inject(USAGE_EVENT_REPOSITORY_TOKEN)
    private readonly usageEventRepo: UsageEventRepository,
    private readonly configProvider: ConfigProvider
  ) {}

  /**
   * Pre-flight admission control and atomic capacity reservation.
   *
   * Validates effective quota limit against active commercial tier baseline,
   * then acquires an atomic reservation hold in the admission provider.
   *
   * @param params - Admission and reservation parameters.
   * @returns TaskEither resolving to void on success, or Left with error.
   */
  public admitAndReserve(params: AdmitAndReserveParams): TE.TaskEither<UsageMeteringError, void> {
    const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)

    return pipe(
      TE.fromEither(parseBillingPeriod(params.period)),
      TE.chainW(() =>
        pipe(
          resolveEffectiveLimit({
            metric: params.metric,
            tier: this.configProvider.planTier
          }),
          TE.fromEither,
          TE.mapLeft((): UsageMeteringError => "quota_missing_configuration")
        )
      ),
      TE.chainW(limitResult => {
        const limitNumber = limitResult.isUnlimited ? UNLIMITED_QUOTA_SENTINEL : limitResult.limit

        if (limitNumber !== UNLIMITED_QUOTA_SENTINEL && params.estimatedUnits > limitNumber)
          return TE.left<UsageMeteringError, number>("quota_exceeded")

        return TE.right<UsageMeteringError, number>(limitNumber)
      }),
      TE.chainW(limitNumber =>
        pipe(
          this.admissionClient.reserve(key, limitNumber, params.estimatedUnits),
          TE.mapLeft((error): UsageMeteringError => {
            Logger.error(`Quota admission reservation error for key ${key}`, error)
            return "unknown_error"
          })
        )
      ),
      TE.chainW(reservation =>
        reservation.allowed
          ? TE.right<UsageMeteringError, void>(undefined)
          : TE.left<UsageMeteringError, void>("quota_exceeded")
      )
    )
  }

  /**
   * Post-operation settlement and durable ledger recording.
   *
   * =========================================================================
   * Architectural Strategy & Dual-Write Atomicity Rationale:
   * =========================================================================
   * 1. Order of Operations:
   *    - Step 1 (Durable Ledger): Persist immutable UsageEvent to the durable database.
   *    - Step 2 (Admission Cache): Settle in the fast admission cache (-estimated, +actual).
   *
   * 2. Core Trade-off (Reliable Ledger vs. Reliable Blocker):
   *    - 2-Phase Commit (2PC) is deliberately avoided to eliminate distributed locks
   *      and coordination latency across the ledger and cache databases.
   *    - The durable ledger is the authoritative legal, financial, and audit system of record.
   *    - Sporadic Failures: In the rare event of a process crash or transient network drop
   *      between Step 1 and Step 2, the failure is strictly isolated to that specific
   *      invocation: the durable ledger is complete, and the admission cache under-counts
   *      only by that single operation's units until period reset or reconciliation.
   *    - Cache Outages: If the admission cache database is completely down, pre-flight
   *      `admitAndReserve` fails-closed (admission error), preventing runaway over-consumption
   *      by halting new invocations until the dependency recovers.
   *
   * 3. Performance & Latency Profile:
   *    - Pre-flight checks (`admitAndReserve`) query only the fast in-memory admission cache (<2ms).
   *    - Settlement (`settleUsage`) writes synchronously to the durable database.
   *    - Current Workload Assumption: Metered operations are currently coarse-grained,
   *      asynchronous background tasks (e.g. multi-second LLM evaluations/agent workflows)
   *      where a 3-5ms database write has negligible impact on overall job duration.
   *    - Future Workload Caveat: If metering expands to high-frequency, low-latency, or
   *      synchronous user-facing request paths, synchronous database persistence during
   *      settlement will place database I/O directly in the critical path. Under those
   *      conditions, an asynchronous buffer, write-behind queue, or batching mechanism
   *      would be required.
   * =========================================================================
   *
   * @param params - Settlement parameters including estimated and actual consumed units.
   * @returns TaskEither resolving to void on success, or Left with error.
   */
  public settleUsage(params: SettleUsageParams): TE.TaskEither<UsageMeteringError, void> {
    const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)

    return pipe(
      TE.fromEither(parseBillingPeriod(params.period)),
      TE.chainW(() =>
        pipe(
          this.usageEventRepo.persist({
            entityType: params.entity.type,
            entityId: params.entity.id,
            actor: params.actor,
            metric: params.metric,
            quantity: BigInt(params.actualUnits),
            isBillable: params.isBillable ?? true,
            occurredAt: new Date(),
            metadata: params.metadata ?? null
          }),
          TE.mapLeft((error): UsageMeteringError => {
            Logger.error(`Failed to persist usage event to database for key ${key}`, error)
            return "unknown_error"
          })
        )
      ),
      TE.chainW(() =>
        pipe(
          this.admissionClient.settle(key, params.estimatedUnits, params.actualUnits),
          TE.mapLeft((error): UsageMeteringError => {
            Logger.error(`Failed to settle quota reservation in Redis for key ${key}`, error)
            return "unknown_error"
          }),
          TE.map(() => undefined)
        )
      )
    )
  }

  /**
   * Releases an inflight capacity reservation upon task cancellation or unhandled failure.
   *
   * @param params - Cancellation parameters.
   * @returns TaskEither resolving to void on success.
   */
  public cancelReservation(params: CancelReservationParams): TE.TaskEither<UsageMeteringError, void> {
    const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)

    return pipe(
      TE.fromEither(parseBillingPeriod(params.period)),
      TE.chainW(() =>
        pipe(
          this.admissionClient.release(key, params.estimatedUnits),
          TE.mapLeft((error): UsageMeteringError => {
            Logger.error(`Failed to cancel quota reservation for key ${key}`, error)
            return "unknown_error"
          })
        )
      )
    )
  }

  /**
   * Inspects billing period consumption, active reservations, and remaining quota balances for an organization.
   *
   * @param requestor - Authenticated entity performing the request.
   * @param orgId - Organization UUID.
   * @param period - Billing period (YYYY-MM). Defaults to current active period if omitted.
   * @param metricFilter - Optional single metric filter.
   * @returns TaskEither resolving to the complete OrganizationUsageSummary.
   */
  public getOrganizationUsage(
    requestor: AuthenticatedEntity,
    orgId: string,
    period?: string,
    metricFilter?: UsageMetric
  ): TE.TaskEither<UsageMeteringError, OrganizationUsageSummary> {
    const userResult = validateUserEntity(requestor)
    if (E.isLeft(userResult) || userResult.right.orgRole !== OrgRole.ADMIN)
      return TE.left("requestor_not_authorized" as const)

    // TODO(long-term): once multi-org support is implemented, orgId should be looked up dynamically
    if (orgId !== DEFAULT_ORG_ID) return TE.left("organization_not_found" as const)

    const activePeriod = period ?? formatBillingPeriod(new Date())
    const metricsToQuery = metricFilter ? [metricFilter] : ALL_METERED_METRICS

    return pipe(
      TE.fromEither(parseBillingPeriod(activePeriod)),
      TE.chainW(({periodStartsAt, periodEndsAt}) =>
        pipe(
          metricsToQuery.map(metric => this.getMetricUsage(orgId, metric, activePeriod)),
          TE.sequenceArray,
          TE.map(metrics => ({
            orgId,
            period: activePeriod,
            periodStartsAt,
            periodEndsAt,
            metrics: Array.from(metrics)
          }))
        )
      )
    )
  }

  private getMetricUsage(
    orgId: string,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, MetricUsageSummary> {
    const key = this.buildAdmissionKey(orgId, metric, period)

    return pipe(
      TE.fromEither(resolveEffectiveLimit({metric, tier: this.configProvider.planTier})),
      TE.mapLeft((): UsageMeteringError => "quota_missing_configuration"),
      TE.bindTo("limitResult"),
      TE.bindW("usage", () =>
        pipe(
          this.admissionClient.getUsage(key),
          TE.mapLeft((error): UsageMeteringError => {
            Logger.error(`Failed to get usage from admission provider for key ${key}`, error)
            return "unknown_error"
          })
        )
      ),
      TE.map(({limitResult, usage}): MetricUsageSummary => {
        const limit = limitResult.isUnlimited ? "UNLIMITED" : limitResult.limit
        return {
          metric,
          limit,
          consumed: usage.consumed,
          reserved: usage.reserved,
          remaining: calculateRemainingQuota(limit, usage.consumed, usage.reserved),
          unit: getMetricUnit(metric)
        }
      })
    )
  }

  private buildAdmissionKey(orgId: string, metric: UsageMetric, period: string): string {
    const prefix = this.configProvider.redisConfig.prefix ?? ""
    return `${prefix}usage:${orgId}:${metric}:${period}`
  }
}
