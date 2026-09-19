import {chainNullableToLeft} from "./utils"
import {fromEitherPromise, fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {TenantContext, UsageMetric, Versioned} from "@domain"
import {
  UsageError,
  UsageOperation,
  UsageOperationRecord,
  UsageOperationRepository,
  UsageOperationStateSnapshot,
  UsageSettlement,
  UsageOperationFactory,
  UsageSettlementFactory,
  UsageSnapshotFactory
} from "@services"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {POSTGRES_BIGINT_LOWER_BOUND, USAGE_SETTLEMENT_STORAGE_REVISION} from "./constants"
import {UsageOperationTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError} from "./errors"
import {Prisma} from "@prisma/client"

@Injectable()
export class UsageOperationDbRepository implements UsageOperationRepository {
  constructor(private readonly dbClient: UsageOperationTenantClient) {}

  getOperationStates(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageError, ReadonlyArray<UsageOperationStateSnapshot>> {
    return fromEitherPromise(
      async () => {
        const rows = await this.dbClient.cx.usageOperation.findMany({
          where: {organizationId: context.organizationId, metric, period},
          orderBy: {operationId: "asc"}
        })
        return pipe(
          E.sequenceArray(
            rows.map(row =>
              pipe(
                toUsageOperation(row),
                E.map(operation => ({
                  operationId: operation.operationId,
                  estimatedUnits: operation.estimatedUnits,
                  expiresAt: operation.expiresAt,
                  // TODO: why are we setting compeltedAt instead of receiving it from the domain ?
                  ...(row.status === "reserved" ? {} : {completedAt: row.updatedAt}),
                  state: row.status,
                  actualUnits: row.actualUnits === null ? undefined : row.actualUnits
                }))
              )
            )
          ),
          E.chainW(operations => UsageSnapshotFactory.validateOperations(operations))
        )
      },
      error => this.mapError(error, "operation states")
    )
  }

  get(context: TenantContext, operationId: string): TE.TaskEither<UsageError, UsageOperationRecord> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageOperation.findUnique({
            where: {organizationId_operationId: {organizationId: context.organizationId, operationId}}
          }),
        error => this.mapError(error, "get")
      ),
      chainNullableToLeft("operation_mismatch" as const),
      TE.chainEitherKW(toUsageOperationRecord)
    )
  }

  reserve(
    input: UsageOperation,
    creation: {readonly id: string; readonly createdAt: Date}
  ): TE.TaskEither<UsageError, "new" | "duplicate"> {
    return fromEitherPromise(
      async () => {
        const inserted = await this.dbClient.cx.usageOperation.createMany({
          data: [
            {
              id: creation.id,
              organizationId: input.organizationId,
              operationId: input.operationId,
              metric: input.metric,
              period: input.period,
              entityType: input.entityType,
              entityId: input.entityId,
              actorType: input.actor.type,
              actorId: input.actor.id,
              actorDisplayName: input.actor.displayName,
              estimatedUnits: input.estimatedUnits,
              expiresAt: input.expiresAt,
              isBillable: input.isBillable,
              status: "reserved",
              createdAt: creation.createdAt,
              updatedAt: creation.createdAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          ],
          skipDuplicates: true
        })
        if (inserted.count === 1) return E.right("new" as const)

        const existing = await this.dbClient.cx.usageOperation.findUnique({
          where: {organizationId_operationId: {organizationId: input.organizationId, operationId: input.operationId}}
        })
        return pipe(
          E.fromNullable("repository_dependency_error" as const)(existing),
          E.chainW(toUsageOperation),
          E.chainW(stored =>
            UsageOperationFactory.isSameOperation(stored, input)
              ? E.right("duplicate" as const)
              : E.left("operation_mismatch" as const)
          )
        )
      },
      error => this.mapError(error, "reserve")
    )
  }

  compareAndSetOperation(
    previous: UsageOperationRecord,
    settlement: UsageSettlement,
    updatedAt: Date
  ): TE.TaskEither<UsageError | "concurrency_error", void> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageOperation.update({
            where: {
              organizationId_operationId: {
                organizationId: previous.organizationId,
                operationId: previous.operationId
              },
              occ: previous.occ
            },
            data: {
              status: settlement.state,
              ...(settlement.state === "settled" ? {actualUnits: settlement.actualUnits} : {}),
              updatedAt,
              occ: {increment: 1}
            }
          }),
        error =>
          isPrismaRecordNotFoundError(error, Prisma.ModelName.UsageOperation)
            ? ("concurrency_error" as const)
            : this.mapError(error, "compareAndSetOperation")
      ),
      TE.map(() => undefined)
    )
  }

  createSettlementIntent(
    settlement: UsageSettlement,
    creation: {readonly id: string; readonly createdAt: Date; readonly occ: bigint}
  ): TE.TaskEither<UsageError, void> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageSettlementIntent.create({
            data: {
              id: creation.id,
              organizationId: settlement.organizationId,
              operationId: settlement.operationId,
              revision: USAGE_SETTLEMENT_STORAGE_REVISION,
              desiredStatus: settlement.state,
              ...(settlement.state === "settled" ? {actualUnits: settlement.actualUnits} : {}),
              availableAt: creation.createdAt,
              createdAt: creation.createdAt,
              occ: creation.occ
            }
          }),
        error => this.mapError(error, "createSettlementIntent")
      ),
      TE.map(() => undefined)
    )
  }

  getReservedOperations(
    context: TenantContext,
    limit: number
  ): TE.TaskEither<UsageError, ReadonlyArray<UsageOperation>> {
    if (!Number.isSafeInteger(limit) || limit < 1) return TE.left("invalid_limit")
    return fromEitherPromise(
      async () => {
        const rows = await this.dbClient.cx.usageOperation.findMany({
          where: {organizationId: context.organizationId, status: "reserved"},
          orderBy: [{createdAt: "asc"}, {id: "asc"}],
          take: limit
        })
        return E.sequenceArray(rows.map(toUsageOperation))
      },
      error => this.mapError(error, "getReservedOperations")
    )
  }

  getSettlement(context: TenantContext, operationId: string): TE.TaskEither<UsageError, UsageSettlement> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageSettlementIntent.findUnique({
            where: {
              organizationId_operationId_revision: {
                organizationId: context.organizationId,
                operationId,
                revision: USAGE_SETTLEMENT_STORAGE_REVISION
              }
            },
            include: {usageOperations: true}
          }),
        error => this.mapError(error, "getSettlement")
      ),
      chainNullableToLeft("settlement_not_found" as const),
      TE.chainEitherKW(intent =>
        toUsageSettlement(
          toUsageOperation(intent.usageOperations),
          intent.revision,
          intent.desiredStatus,
          intent.actualUnits
        )
      )
    )
  }

  /** Reads a bounded batch of unacknowledged intents with their operations; does not mutate or claim rows. */
  getPendingSettlements(
    context: TenantContext,
    batchSize: number
  ): TE.TaskEither<UsageError, ReadonlyArray<UsageSettlement>> {
    return fromEitherPromise(
      async () => {
        const intents = await this.dbClient.cx.usageSettlementIntent.findMany({
          where: {organizationId: context.organizationId, appliedAt: null},
          orderBy: [{availableAt: "asc"}, {id: "asc"}],
          take: batchSize,
          include: {usageOperations: true}
        })
        return E.sequenceArray(
          intents.map(intent =>
            toUsageSettlement(
              toUsageOperation(intent.usageOperations),
              intent.revision,
              intent.desiredStatus,
              intent.actualUnits
            )
          )
        )
      },
      error => this.mapError(error, "pending settlements")
    )
  }

  getSettlementApplicationState(
    context: TenantContext,
    operationId: string
  ): TE.TaskEither<UsageError, Versioned<{readonly appliedAt: Date | null}>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageSettlementIntent.findUnique({
            where: {
              organizationId_operationId_revision: {
                organizationId: context.organizationId,
                operationId,
                revision: USAGE_SETTLEMENT_STORAGE_REVISION
              }
            },
            select: {appliedAt: true, occ: true}
          }),
        error => this.mapError(error, "getSettlementApplicationState")
      ),
      chainNullableToLeft("settlement_not_found" as const)
    )
  }

  acknowledge(
    context: TenantContext,
    operationId: string,
    occ: bigint,
    appliedAt: Date
  ): TE.TaskEither<UsageError | "concurrency_error", void> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.usageSettlementIntent.update({
            where: {
              organizationId_operationId_revision: {
                organizationId: context.organizationId,
                operationId,
                revision: USAGE_SETTLEMENT_STORAGE_REVISION
              },
              occ
            },
            data: {appliedAt, occ: {increment: 1}}
          }),
        error =>
          isPrismaRecordNotFoundError(error, Prisma.ModelName.UsageSettlementIntent)
            ? ("concurrency_error" as const)
            : this.mapError(error, "acknowledge")
      ),
      TE.map(() => undefined)
    )
  }

  private mapError(error: unknown, operation: string): UsageError {
    Logger.error(`Usage operation ${operation} failed`, error)
    return "repository_dependency_error"
  }
}

function toUsageOperation(row: {
  readonly organizationId: string
  readonly operationId: string
  readonly metric: string
  readonly period: string
  readonly entityType: string
  readonly entityId: string
  readonly actorType: string
  readonly actorId: string
  readonly actorDisplayName: string
  readonly estimatedUnits: bigint
  readonly isBillable: boolean
  readonly expiresAt: Date
}): E.Either<UsageError, UsageOperation> {
  const result = UsageOperationFactory.validate({
    organizationId: row.organizationId,
    operationId: row.operationId,
    metric: row.metric,
    period: row.period,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: {type: row.actorType, id: row.actorId, displayName: row.actorDisplayName},
    estimatedUnits: row.estimatedUnits,
    isBillable: row.isBillable,
    expiresAt: row.expiresAt
  })
  return result
}

function toUsageOperationRecord(
  row: Parameters<typeof toUsageOperation>[0] & {
    readonly status: string
    readonly actualUnits: bigint | null
    readonly occ: bigint
    readonly updatedAt: Date
  }
): E.Either<UsageError, UsageOperationRecord> {
  return pipe(
    toUsageOperation(row),
    E.chainW(operation =>
      pipe(
        UsageSnapshotFactory.validateOperation({
          operationId: operation.operationId,
          estimatedUnits: operation.estimatedUnits,
          expiresAt: operation.expiresAt,
          ...(row.status === "reserved" ? {} : {completedAt: row.updatedAt}),
          state: row.status,
          actualUnits: row.actualUnits === null ? undefined : row.actualUnits
        }),
        E.map(state => ({...operation, ...state, occ: row.occ}))
      )
    )
  )
}

function toUsageSettlement(
  operation: E.Either<UsageError, UsageOperation>,
  storageRevision: bigint,
  state: string,
  actualUnits: bigint | null
): E.Either<UsageError, UsageSettlement> {
  if (E.isLeft(operation)) return operation
  if (storageRevision !== USAGE_SETTLEMENT_STORAGE_REVISION) return E.left("unsupported_settlement_revision")
  const result = UsageSettlementFactory.validate({
    ...operation.right,
    state,
    actualUnits: actualUnits === null ? null : actualUnits
  })
  return result
}
