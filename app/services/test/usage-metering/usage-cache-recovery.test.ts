import {UsageCacheSnapshotFactory} from "@services/durable-work/models"
import {TenantOutboxService} from "@services/durable-work/tenant-outbox.service"
import {unwrapRight} from "@utils/either"
import {Test} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {TenantContext} from "@domain"
import {toOrganizationId} from "@test/organization-id"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {QueueService} from "@services/queue"
import {OrganizationEntitlementService} from "@services/tenancy/organization-entitlement.service"
import {TRANSACTION_MANAGER_TOKEN} from "@services/transaction/interfaces"
import {USAGE_OPERATION_REPOSITORY_TOKEN, UsageCacheSnapshot, UsageError} from "@services/durable-work/interfaces"
import {
  AdmitAndReserveParams,
  QUOTA_ADMISSION_CLIENT_TOKEN,
  QuotaAdmissionError,
  ReservationResult,
  USAGE_EVENT_REPOSITORY_TOKEN,
  UsageMeteringService,
  UsageOperationValidationError
} from "@services/usage-metering"

const input: AdmitAndReserveParams = {
  organizationId: toOrganizationId("0198ed6b-0c41-7000-8000-000000000001"),
  operationId: "0198ed6b-0c41-7000-8000-000000000002",
  entity: {type: "Workflow", id: "0198ed6b-0c41-7000-8000-000000000003"},
  actor: {type: "user", id: "0198ed6b-0c41-7000-8000-000000000004", displayName: "Test"},
  metric: "MAX_LLM_TOKENS_PER_MONTH",
  period: "2026-10",
  estimatedUnits: 20
}

const unavailable = (): TE.TaskEither<QuotaAdmissionError, {consumed: number; reserved: number}> =>
  TE.left({type: "cache_unavailable"})

describe("Usage cache background recovery", () => {
  const cache = {
    getUsage: jest.fn(unavailable),
    reserveOperation: jest.fn((): TE.TaskEither<QuotaAdmissionError | "quota_exceeded", ReservationResult> =>
      TE.right({consumed: 0, reserved: 20})
    ),
    beginRebuild: jest.fn((): TE.TaskEither<QuotaAdmissionError, "ready" | "claimed" | "busy"> => TE.right("claimed")),
    restore: jest.fn((): TE.TaskEither<QuotaAdmissionError, void> => TE.right(undefined))
  }
  const operations = {
    reserve: jest.fn(() => TE.right("new" as const)),
    getUsageSnapshot: jest.fn((): TE.TaskEither<UsageError, UsageCacheSnapshot> =>
      TE.right(unwrapRight(UsageCacheSnapshotFactory.validate({consumed: 15, operations: []})))
    )
  }
  const queue = {requestUsageCacheRecovery: jest.fn(() => TE.right(undefined))}
  let service: UsageMeteringService

  beforeEach(async () => {
    jest.clearAllMocks()
    cache.getUsage.mockImplementation(unavailable)
    const module = await Test.createTestingModule({
      providers: [
        UsageMeteringService,
        {provide: QUOTA_ADMISSION_CLIENT_TOKEN, useValue: cache},
        {provide: USAGE_EVENT_REPOSITORY_TOKEN, useValue: {}},
        {provide: ConfigProvider, useValue: {redisConfig: {prefix: "test:"}}},
        {
          provide: TRANSACTION_MANAGER_TOKEN,
          useValue: {
            execute: jest.fn((_context: TenantContext, operation: () => TE.TaskEither<unknown, unknown>) => operation())
          }
        },
        {provide: OrganizationEntitlementService, useValue: {getPlanTier: () => TE.right("SELF_HOSTED_UNLIMITED")}},
        {provide: USAGE_OPERATION_REPOSITORY_TOKEN, useValue: operations},
        {provide: TenantOutboxService, useValue: {}},
        {provide: QueueService, useValue: queue}
      ]
    }).compile()
    service = module.get(UsageMeteringService)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid reconciliation batch size %s",
    async batchSize => {
      expect(await service.reconcile({organizationId: input.organizationId}, batchSize)()).toEqual(
        E.left("invalid_batch_size")
      )
    }
  )

  it.each<[AdmitAndReserveParams, UsageOperationValidationError]>([
    [{...input, operationId: "invalid"}, "invalid_operation_id"],
    [{...input, entity: {...input.entity, id: "invalid"}}, "invalid_entity_id"],
    [{...input, actor: {...input.actor, id: "invalid"}}, "invalid_actor_id"],
    [{...input, estimatedUnits: -1}, "invalid_estimated_units"],
    [{...input, estimatedUnits: 0.5}, "invalid_estimated_units"],
    [{...input, estimatedUnits: Number.MAX_SAFE_INTEGER + 1}, "invalid_estimated_units"],
    [{...input, estimatedUnits: NaN}, "invalid_estimated_units"]
  ])("preserves %j validation failure as %s before admission or settlement", async (params, error) => {
    expect(await service.admitAndReserve(params)()).toEqual(E.left(error))
    expect(await service.settleUsage({...params, actualUnits: 10})()).toEqual(E.left(error))
    expect(cache.getUsage).not.toHaveBeenCalled()
    expect(operations.reserve).not.toHaveBeenCalled()
    expect(queue.requestUsageCacheRecovery).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "preserves invalid actual units %s",
    async actualUnits => {
      expect(await service.settleUsage({...input, actualUnits})()).toEqual(E.left("invalid_actual_units"))
    }
  )

  it("preserves cancellation validation failures", async () => {
    expect(await service.cancelReservation({...input, operationId: "invalid"})()).toEqual(
      E.left("invalid_operation_id")
    )
    expect(await service.cancelReservation({...input, estimatedUnits: -1})()).toEqual(E.left("invalid_estimated_units"))
  })

  it.each<QuotaAdmissionError>([
    {type: "admission_error", error: new Error("Redis connection failed")},
    {type: "invalid_response", error: ["unexpected"]},
    {type: "operation_mismatch"}
  ])("forwards $type from readiness and reservation without losing detail", async error => {
    cache.getUsage.mockReturnValueOnce(TE.left(error))
    const readiness = await service.admitAndReserve(input)()
    if (E.isRight(readiness)) throw new Error("Expected readiness failure")
    expect(readiness.left).toBe(error)

    cache.getUsage.mockReturnValueOnce(TE.right({consumed: 0, reserved: 0}))
    cache.reserveOperation.mockReturnValueOnce(TE.left(error))
    const reservation = await service.admitAndReserve(input)()
    if (E.isRight(reservation)) throw new Error("Expected reservation failure")
    expect(reservation.left).toBe(error)
    expect(queue.requestUsageCacheRecovery).not.toHaveBeenCalled()
  })

  it("forwards quota denial without requesting cache recovery", async () => {
    cache.getUsage.mockReturnValueOnce(TE.right({consumed: 0, reserved: 0}))
    cache.reserveOperation.mockReturnValueOnce(TE.left("quota_exceeded"))
    expect(await service.admitAndReserve(input)()).toEqual(E.left("quota_exceeded"))
    expect(queue.requestUsageCacheRecovery).not.toHaveBeenCalled()
  })

  it("preserves snapshot failures and invalid billing periods during background recovery", async () => {
    operations.getUsageSnapshot.mockReturnValueOnce(TE.left("repository_dependency_error"))
    expect(
      await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    ).toEqual(E.left("repository_dependency_error"))
    expect(await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, "invalid")()).toEqual(
      E.left("billing_period_invalid_format")
    )
  })

  it.each<UsageError>([
    "invalid_actor",
    "invalid_revision",
    "invalid_actual_units",
    "duplicate_usage_operation",
    "usage_snapshot_quantity_overflow",
    "usage_snapshot_malformed_object"
  ])("preserves %s from the snapshot repository through recovery", async error => {
    // Given
    operations.getUsageSnapshot.mockReturnValueOnce(TE.left(error))
    // When
    const result = await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    // Expect
    expect(result).toEqual(E.left(error))
    expect(cache.restore).not.toHaveBeenCalled()
  })

  it.each<QuotaAdmissionError>([
    {type: "admission_error", error: new Error("Restore connection failed")},
    {type: "cache_unavailable"}
  ])("preserves the original $type restore failure during background recovery", async error => {
    cache.restore.mockReturnValueOnce(TE.left(error))
    const result = await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    if (E.isRight(result)) throw new Error("Expected restore failure")
    expect(result.left).toBe(error)
  })

  it("requests recovery without reading PostgreSQL or persisting a reservation", async () => {
    expect(await service.admitAndReserve(input)()).toEqual(E.left("quota_cache_unavailable"))
    expect(queue.requestUsageCacheRecovery).toHaveBeenCalledWith({
      organizationId: input.organizationId,
      metric: input.metric,
      period: input.period
    })
    expect(operations.getUsageSnapshot).not.toHaveBeenCalled()
    expect(operations.reserve).not.toHaveBeenCalled()
    expect(cache.beginRebuild).not.toHaveBeenCalled()
  })

  it("requests recovery if Redis disappears between the readiness check and reservation", async () => {
    cache.getUsage.mockReturnValueOnce(TE.right({consumed: 0, reserved: 0}))
    cache.reserveOperation.mockReturnValueOnce(TE.left({type: "cache_unavailable"}))
    expect(await service.admitAndReserve(input)()).toEqual(E.left("quota_cache_unavailable"))
    expect(operations.reserve).toHaveBeenCalledTimes(1)
    expect(queue.requestUsageCacheRecovery).toHaveBeenCalledTimes(1)
    expect(operations.getUsageSnapshot).not.toHaveBeenCalled()
  })

  it("reads and restores the snapshot only through the recovery entry point", async () => {
    expect(
      await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    ).toEqual(E.right(undefined))
    expect(operations.getUsageSnapshot).toHaveBeenCalledWith(
      {organizationId: input.organizationId},
      input.metric,
      input.period
    )
    expect(cache.restore).toHaveBeenCalledWith(
      `test:usage:${input.organizationId}:${input.metric}:${input.period}`,
      expect.any(String),
      {consumed: 15, operations: []},
      expect.any(Date)
    )
  })

  it("does not rebuild a ready key or read a snapshot owned by another rebuilder", async () => {
    cache.beginRebuild.mockReturnValueOnce(TE.right("ready"))
    expect(
      await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    ).toEqual(E.right(undefined))
    cache.beginRebuild.mockReturnValueOnce(TE.right("busy"))
    expect(
      await service.rebuildUsageCache({organizationId: input.organizationId}, input.metric, input.period)()
    ).toEqual(E.left("quota_cache_unavailable"))
    expect(operations.getUsageSnapshot).not.toHaveBeenCalled()
  })
})
