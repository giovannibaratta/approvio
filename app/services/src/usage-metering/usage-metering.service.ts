import {TenantOutboxService} from "../durable-work/tenant-outbox.service"
import {
  ALL_METERED_METRICS,
  AuthenticatedEntity,
  calculateRemainingQuota,
  formatBillingPeriod,
  getMetricUnit,
  OrgRole,
  OrganizationId,
  PlanTier,
  parseBillingPeriod,
  resolveEffectiveLimit,
  TenantContext,
  TenantEvent,
  TierQuotaLimit,
  UsageMetric
} from "@domain"
import {ConfigProvider} from "@external/config"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {v7 as uuidv7} from "uuid"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {validateUserEntity} from "../shared/types"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {inTransaction} from "../transaction/in-transaction"
import {OrganizationEntitlementService} from "../tenancy/organization-entitlement.service"
import {
  USAGE_OPERATION_REPOSITORY_TOKEN,
  UsageOperation,
  UsageOperationFactory,
  UsageSettlementResultFactory,
  UsageOperationRepository
} from "../durable-work/interfaces"
import {bestEffort, isUUIDv7} from "@utils"
import {QueueService} from "../queue"
import {
  AdmitAndReserveParams,
  CancelReservationParams,
  MetricUsageSummary,
  OrganizationUsageSummary,
  QUOTA_ADMISSION_CLIENT_TOKEN,
  QuotaAdmissionClient,
  QuotaAdmissionError,
  UsageCacheRecoveryRequest,
  SettleUsageParams,
  USAGE_EVENT_REPOSITORY_TOKEN,
  UsageEventRepository,
  UsageMeteringError,
  UsageOperationValidationError
} from "./interfaces"

// Retain terminal cache facts through the billing period plus the reconciliation window.
const TERMINAL_CACHE_RETENTION_DAYS = 90

@Injectable()
export class UsageMeteringService {
  constructor(
    private readonly tenantOutbox: TenantOutboxService,
    @Inject(QUOTA_ADMISSION_CLIENT_TOKEN)
    private readonly admissionClient: QuotaAdmissionClient,
    @Inject(USAGE_EVENT_REPOSITORY_TOKEN)
    private readonly usageEventRepo: UsageEventRepository,
    private readonly configProvider: ConfigProvider,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager,
    private readonly entitlements: OrganizationEntitlementService,
    @Inject(USAGE_OPERATION_REPOSITORY_TOKEN) private readonly usageOperations: UsageOperationRepository,
    private readonly queueService: QueueService
  ) {}

  /**
   * Pre-flight admission control and atomic capacity reservation.
   *
   * Validates the operation and billing period, checks cache readiness, and resolves
   * the organization's effective quota limit. Persists the operation before acquiring
   * an idempotent Redis hold so cache recovery can reconstruct outstanding reservations.
   *
   * @param params - Admission and reservation parameters.
   * @returns TaskEither resolving to void on success, or Left with error.
   */
  public admitAndReserve(params: AdmitAndReserveParams): TE.TaskEither<UsageMeteringError, void> {
    const context = {organizationId: params.organizationId}
    const key = this.buildAdmissionKey(params.organizationId, params.metric, params.period)

    return pipe(
      TE.fromEither(validateUsageOperation(params)),
      TE.bindTo("operation"),
      TE.chainFirstW(() => TE.fromEither(parseBillingPeriod(params.period))),
      TE.chainFirstW(() => this.checkUsageCacheReady(context, params.metric, params.period)),
      TE.bindW("tier", () => this.entitlements.getPlanTier(context)),
      TE.bindW("limitResult", ({tier}) => TE.fromEither(resolveEffectiveLimit({metric: params.metric, tier}))),
      TE.let("limit", ({limitResult}): TierQuotaLimit => (limitResult.isUnlimited ? "UNLIMITED" : limitResult.limit)),
      // Reject impossible estimates before creating a durable recovery hold.
      TE.chainFirstW(({limit}) =>
        limit !== "UNLIMITED" && params.estimatedUnits > limit
          ? TE.left("quota_exceeded" as const)
          : TE.right(undefined)
      ),
      inTransaction(this.txManager, context, ({operation, limit}) =>
        pipe(
          this.usageOperations.reserve(operation),
          TE.map(() => limit)
        )
      ),
      TE.chainW(limit =>
        this.requestRecoveryOnCacheMiss(
          this.admissionClient.reserveOperation(key, params.operationId, limit, params.estimatedUnits),
          {organizationId: params.organizationId, metric: params.metric, period: params.period}
        )
      ),
      TE.map(() => undefined)
    )
  }

  /**
   * Post-operation settlement and durable ledger recording.
   *
   * Architectural strategy and dual-write ordering:
   *
   * 1. Durable transaction: finish the operation and record its settlement intent,
   *    outbox event, and immutable usage event together in the database. A ledger write
   *    failure rolls back the terminal transition and its delivery records.
   * 2. Queue publication: after commit, attempt delivery of the settlement event.
   *    Publication failure leaves the durable facts intact and the outbox available
   *    for later delivery. Queue failure does not roll back the committed settlement.
   * 3. Admission cache: the settlement worker releases the estimated hold and adds
   *    actual usage atomically. Operation markers make repeated delivery a no-op.
   *    A missing cache queues background recovery and defers settlement.
   *
   * The durable database owns billing and audit facts. The cache owns the admission counters and
   * retains the reservation until settlement is applied. There is no distributed
   * transaction across the database, queue, and cache.
   *
   * The database write is synchronous; applying the cache settlement is asynchronous.
   * This path is intended for coarse-grained background work. High-frequency request
   * metering would need a separate latency and persistence design.
   *
   * @param params - Settlement parameters including estimated and actual consumed units.
   * @returns TaskEither resolving to void after durable commit, or Left with error.
   */
  public settleUsage(params: SettleUsageParams): TE.TaskEither<UsageMeteringError, void> {
    const context = {organizationId: params.organizationId}

    return pipe(
      TE.fromEither(validateUsageOperation(params)),
      TE.chainFirstW(() =>
        !Number.isSafeInteger(params.actualUnits) || params.actualUnits < 0
          ? TE.left("invalid_actual_units" as const)
          : TE.right(undefined)
      ),
      TE.chainFirstW(() => TE.fromEither(parseBillingPeriod(params.period))),
      inTransaction(this.txManager, context, operation =>
        pipe(
          TE.fromEither(UsageSettlementResultFactory.validate({state: "settled", actualUnits: params.actualUnits})),
          TE.chainW(result => this.usageOperations.completeOperation(operation, result)),
          TE.chainFirstW(event =>
            event === undefined ? TE.right(undefined) : this.tenantOutbox.append(context, event)
          ),
          TE.chainFirstW(() =>
            this.usageEventRepo.persistOperation(context, params.operationId, {
              organizationId: params.organizationId,
              entityType: params.entity.type,
              entityId: params.entity.id,
              actor: params.actor,
              metric: params.metric,
              quantity: BigInt(params.actualUnits),
              isBillable: params.isBillable ?? true,
              occurredAt: new Date(),
              metadata: params.metadata ?? null
            })
          )
        )
      ),
      // An identical terminal retry creates no new event to publish.
      bestEffort(
        (event: TenantEvent | undefined) =>
          event === undefined ? TE.right(undefined) : this.publishUsageSettlement(context, event),
        (error, event) => Logger.warn(`Best-effort delivery failed for ${event?.type} event ${event?.eventId}`, error)
      ),
      TE.map(() => undefined)
    )
  }

  /**
   * Releases an inflight capacity reservation upon task cancellation or unhandled failure.
   *
   * @param params - Cancellation parameters.
   * @returns TaskEither resolving to void on success.
   */
  public cancelReservation(params: CancelReservationParams): TE.TaskEither<UsageMeteringError, void> {
    const context = {organizationId: params.organizationId}
    return pipe(
      TE.fromEither(isUUIDv7(params.operationId) ? E.right(params) : E.left("invalid_operation_id" as const)),
      TE.chainFirstW(() =>
        Number.isSafeInteger(params.estimatedUnits) && params.estimatedUnits >= 0
          ? TE.right(undefined)
          : TE.left("invalid_estimated_units" as const)
      ),
      TE.chainFirstW(() => TE.fromEither(parseBillingPeriod(params.period))),
      inTransaction(this.txManager, context, () => this.usageOperations.get(context, params.operationId)),
      TE.chainFirstW(operation =>
        operation.metric !== params.metric ||
        operation.period !== params.period ||
        operation.estimatedUnits !== params.estimatedUnits
          ? TE.left("operation_mismatch" as const)
          : TE.right(undefined)
      ),
      inTransaction(this.txManager, context, operation =>
        pipe(
          TE.fromEither(UsageSettlementResultFactory.validate({state: "cancelled"})),
          TE.chainW(result => this.usageOperations.completeOperation(operation, result)),
          TE.chainFirstW(event =>
            event === undefined ? TE.right(undefined) : this.tenantOutbox.append(context, event)
          )
        )
      ),
      // An identical terminal retry creates no new event to publish.
      bestEffort(
        (event: TenantEvent | undefined) =>
          event === undefined ? TE.right(undefined) : this.publishUsageSettlement(context, event),
        (error, event) => Logger.warn(`Best-effort delivery failed for ${event?.type} event ${event?.eventId}`, error)
      ),
      TE.map(() => undefined)
    )
  }

  private publishUsageSettlement(context: TenantContext, event: TenantEvent) {
    return pipe(
      this.queueService.enqueue(event),
      TE.chainW(() => this.tenantOutbox.markPublished(context, event.eventId))
    )
  }

  public applySettlement(
    context: TenantContext,
    operationId: string,
    revision: string
  ): TE.TaskEither<UsageMeteringError, void> {
    return pipe(
      this.txManager.execute(context, () => this.usageOperations.getSettlement(context, operationId, revision)),
      TE.chainFirstW(settlement => this.checkUsageCacheReady(context, settlement.metric, settlement.period)),
      TE.chainW(settlement =>
        pipe(
          TE.fromEither(UsageSettlementResultFactory.validate(settlement)),
          TE.chainW(result =>
            this.requestRecoveryOnCacheMiss(
              this.admissionClient.applySettlement(
                this.buildAdmissionKey(context.organizationId, settlement.metric, settlement.period),
                operationId,
                revision,
                settlement.estimatedUnits,
                result
              ),
              {organizationId: context.organizationId, metric: settlement.metric, period: settlement.period}
            )
          )
        )
      ),
      inTransaction(this.txManager, context, () => this.usageOperations.acknowledge(context, operationId, revision))
    )
  }

  /**
   * Replays one batch of this tenant's unacknowledged settlement intents into the cache.
   * Each successful replay acknowledges its intent in PostgreSQL; replay is idempotent.
   *
   * @param batchSize - Maximum intents to process in this call; a positive safe integer.
   * @returns Number processed if the whole batch succeeds. A failure returns Left;
   * already acknowledged intents remain committed and are excluded from subsequent reads.
   */
  public reconcile(context: TenantContext, batchSize: number): TE.TaskEither<UsageMeteringError, number> {
    return pipe(
      TE.fromEither(
        Number.isSafeInteger(batchSize) && batchSize >= 1 ? E.right(batchSize) : E.left("invalid_batch_size" as const)
      ),
      inTransaction(this.txManager, context, () => this.usageOperations.getPendingSettlements(context, batchSize)),
      TE.bindTo("settlements"),
      TE.chainFirstW(({settlements}) =>
        TE.sequenceArray(
          settlements.map(settlement => this.applySettlement(context, settlement.operationId, settlement.revision))
        )
      ),
      TE.map(({settlements}) => settlements.length)
    )
  }

  /**
   * Inspects billing period consumption, active reservations, and remaining quota balances for an organization.
   *
   * @param requestor - Authenticated entity performing the request.
   * @param context - Tenant context for the organization being inspected.
   * @param period - Billing period (YYYY-MM). Defaults to current active period if omitted.
   * @param metricFilter - Optional single metric filter.
   * @returns TaskEither resolving to the complete OrganizationUsageSummary.
   */
  public getOrganizationUsage(
    requestor: AuthenticatedEntity,
    context: TenantContext,
    period?: string,
    metricFilter?: UsageMetric
  ): TE.TaskEither<UsageMeteringError, OrganizationUsageSummary> {
    const activePeriod = period ?? formatBillingPeriod(new Date())
    const metricsToQuery = metricFilter ? [metricFilter] : ALL_METERED_METRICS

    return pipe(
      TE.fromEither(validateUserEntity(requestor)),
      TE.chainFirstW(user =>
        user.organizationId !== context.organizationId || user.orgRole !== OrgRole.ADMIN
          ? TE.left("requestor_not_authorized" as const)
          : TE.right(undefined)
      ),
      TE.chainW(() => TE.fromEither(parseBillingPeriod(activePeriod))),
      TE.bindTo("billingPeriod"),
      TE.bindW("tier", () => this.entitlements.getPlanTier(context)),
      TE.bindW("metrics", ({tier}) =>
        TE.sequenceArray(
          metricsToQuery.map(metric => this.getMetricUsage(context.organizationId, tier, metric, activePeriod))
        )
      ),
      TE.map(({billingPeriod: {periodStartsAt, periodEndsAt}, metrics}) => ({
        organizationId: context.organizationId,
        period: activePeriod,
        periodStartsAt,
        periodEndsAt,
        metrics: Array.from(metrics)
      }))
    )
  }

  private getMetricUsage(
    orgId: OrganizationId,
    tier: PlanTier,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, MetricUsageSummary> {
    const context = {organizationId: orgId}
    return pipe(
      TE.fromEither(resolveEffectiveLimit({metric, tier})),
      TE.bindTo("limitResult"),
      TE.bindW("usage", () =>
        period < formatBillingPeriod(new Date())
          ? this.getHistoricalUsage(context, metric, period)
          : this.getCurrentUsage(context, metric, period)
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

  /** Reads durable totals, including reservations that outlive their billing period. */
  private getHistoricalUsage(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, {consumed: number; reserved: number}> {
    return pipe(
      this.txManager.execute(context, () => this.usageOperations.getUsageSnapshot(context, metric, period)),
      TE.map(snapshot => ({
        consumed: snapshot.consumed,
        reserved: snapshot.operations.reduce(
          (total, operation) => total + (operation.state === "reserved" ? operation.estimatedUnits : 0),
          0
        )
      }))
    )
  }

  /** Reads Redis totals; an unavailable cache queues recovery and returns a retryable error. */
  private getCurrentUsage(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, {consumed: number; reserved: number}> {
    return this.requestRecoveryOnCacheMiss(
      this.admissionClient.getUsage(this.buildAdmissionKey(context.organizationId, metric, period)),
      {organizationId: context.organizationId, metric, period}
    )
  }

  /** Request background recovery and keep admission closed until the cache is ready. */
  private checkUsageCacheReady(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, void> {
    return pipe(
      this.requestRecoveryOnCacheMiss(
        this.admissionClient.getUsage(this.buildAdmissionKey(context.organizationId, metric, period)),
        {
          organizationId: context.organizationId,
          metric,
          period
        }
      ),
      TE.map(() => undefined)
    )
  }

  /** Forward cache errors unchanged. A cache miss queues recovery and returns a retryable error. */
  private requestRecoveryOnCacheMiss<T>(
    operation: TE.TaskEither<QuotaAdmissionError | "quota_exceeded", T>,
    request: UsageCacheRecoveryRequest
  ): TE.TaskEither<UsageMeteringError, T> {
    return pipe(
      operation,
      TE.orElseW((error): TE.TaskEither<UsageMeteringError, T> => {
        if (typeof error !== "string" && error.type === "cache_unavailable")
          return pipe(
            this.queueService.requestUsageCacheRecovery(request),
            TE.chainW(() => TE.left("quota_cache_unavailable" as const))
          )
        return TE.left(error)
      })
    )
  }

  /**
   * Reconstructs one tenant's metric/period cache from durable PostgreSQL usage.
   * A ready cache is left unchanged; a rebuild already in progress returns
   * quota_cache_unavailable so the caller can retry.
   *
   * After claiming a rebuild lease, reads totals and operation states in a
   * RepeatableRead transaction. Redis installs that snapshot only if the lease
   * is still owned and unexpired, preventing a stale rebuild from overwriting it.
   * Terminal data is retained through period end plus the retention window;
   * outstanding reservations keep the cache alive until settlement or cancellation.
   */
  public rebuildUsageCache(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageMeteringError, void> {
    const key = this.buildAdmissionKey(context.organizationId, metric, period)
    const owner = uuidv7()
    return pipe(
      TE.fromEither(parseBillingPeriod(period)),
      TE.bindTo("billingPeriod"),
      TE.bindW("state", () => this.admissionClient.beginRebuild(key, owner)),
      TE.chainW(({billingPeriod: {periodEndsAt}, state}): TE.TaskEither<UsageMeteringError, void> => {
        if (state === "ready") return TE.right(undefined)
        if (state === "busy") return TE.left("quota_cache_unavailable")
        return pipe(
          this.txManager.execute(context, () => this.usageOperations.getUsageSnapshot(context, metric, period), {
            isolationLevel: "RepeatableRead"
          }),
          TE.chainW(snapshot =>
            this.admissionClient.restore(
              key,
              owner,
              snapshot,
              new Date(periodEndsAt.getTime() + TERMINAL_CACHE_RETENTION_DAYS * 86400000)
            )
          )
        )
      })
    )
  }

  private buildAdmissionKey(orgId: string, metric: UsageMetric, period: string): string {
    const prefix = this.configProvider.redisConfig.prefix ?? ""
    return `${prefix}usage:${orgId}:${metric}:${period}`
  }
}

function validateUsageOperation(
  params: AdmitAndReserveParams
): E.Either<UsageOperationValidationError, UsageOperation> {
  return UsageOperationFactory.validate({
    organizationId: params.organizationId,
    operationId: params.operationId,
    metric: params.metric,
    period: params.period,
    entityType: params.entity.type,
    entityId: params.entity.id,
    actor: params.actor,
    estimatedUnits: params.estimatedUnits,
    isBillable: params.isBillable ?? true
  })
}
