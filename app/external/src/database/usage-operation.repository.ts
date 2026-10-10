import {createHash} from "node:crypto"
import {Injectable, Logger} from "@nestjs/common"
import {TenantContext, TenantEvent, UsageMetric} from "@domain"
import {
  UsageError,
  UsageOperation,
  UsageOperationRepository,
  UsageCacheSnapshot,
  UsageSettlement,
  UsageSettlementResult,
  UsageOperationFactory,
  UsageSettlementFactory,
  UsageCacheSnapshotFactory
} from "@services"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import {generateDeterministicId} from "@utils"
import {UsageOperationTenantClient} from "./tenant-database-clients"

@Injectable()
export class UsageOperationDbRepository implements UsageOperationRepository {
  constructor(private readonly dbClient: UsageOperationTenantClient) {}

  getUsageSnapshot(
    context: TenantContext,
    metric: UsageMetric,
    period: string
  ): TE.TaskEither<UsageError, UsageCacheSnapshot> {
    return TE.tryCatch(
      async () => {
        const rows = await this.dbClient.cx.usageOperation.findMany({
          where: {organizationId: context.organizationId, metric, period},
          orderBy: {operationId: "asc"}
        })
        const snapshot = UsageCacheSnapshotFactory.validate({
          consumed: 0,
          operations: rows.map(row => ({
            operationId: row.operationId,
            estimatedUnits: toUsageOperation(row).estimatedUnits,
            revision: row.occ.toString(),
            state: row.status,
            actualUnits: row.actualUnits === null ? null : Number(row.actualUnits)
          }))
        })
        if (E.isLeft(snapshot)) throw new UsageModelError(snapshot.left)
        const operations = snapshot.right.operations
        for (const row of rows)
          if ((row.status === "reserved" && row.occ !== 0n) || (row.status !== "reserved" && row.occ !== 1n))
            throw new UsageOperationMismatchError()
        const reserved = operations.reduce(
          (sum, operation) => sum + (operation.state === "reserved" ? operation.estimatedUnits : 0),
          0
        )
        if (!Number.isSafeInteger(reserved)) throw new UsageOperationMismatchError()
        const settled = new Map(
          operations
            .filter(operation => operation.state === "settled")
            .map(operation => [
              generateDeterministicId(`usage-event-${context.organizationId}-${operation.operationId}`),
              operation
            ])
        )
        const events = await this.dbClient.cx.usageEvent.findMany({
          where: {
            organizationId: context.organizationId,
            metric,
            id: {in: [...settled.keys()]}
          },
          select: {id: true, quantity: true}
        })
        if (events.length !== settled.size) throw new UsageOperationMismatchError()
        const consumed = events.reduce((sum, event) => {
          if (Number(event.quantity) !== settled.get(event.id)?.actualUnits) throw new UsageOperationMismatchError()
          return sum + Number(event.quantity)
        }, 0)
        if (!Number.isSafeInteger(consumed + reserved) || consumed < 0) throw new UsageOperationMismatchError()
        const result = UsageCacheSnapshotFactory.validate({consumed, operations})
        if (E.isLeft(result)) throw new UsageModelError(result.left)
        return result.right
      },
      error => this.mapError(error, "cache snapshot")
    )
  }

  get(context: TenantContext, operationId: string): TE.TaskEither<UsageError, UsageOperation> {
    return TE.tryCatch(
      async () => {
        const row = await this.dbClient.cx.usageOperation.findUnique({
          where: {organizationId_operationId: {organizationId: context.organizationId, operationId}}
        })
        if (!row) throw new UsageOperationMismatchError()
        return toUsageOperation(row)
      },
      error => this.mapError(error, "get")
    )
  }

  reserve(input: UsageOperation): TE.TaskEither<UsageError, "new" | "duplicate"> {
    const digest = requestDigest(input)
    return TE.tryCatch(
      async () => {
        const inserted = await this.dbClient.cx.usageOperation.createMany({
          data: [
            {
              id: uuidv7(),
              organizationId: input.organizationId,
              operationId: input.operationId,
              metric: input.metric,
              period: input.period,
              entityType: input.entityType,
              entityId: input.entityId,
              actorType: input.actor.type,
              actorId: input.actor.id,
              actorDisplayName: input.actor.displayName,
              estimatedUnits: BigInt(input.estimatedUnits),
              isBillable: input.isBillable,
              status: "reserved",
              requestDigest: digest,
              createdAt: new Date(),
              updatedAt: new Date(),
              occ: 0n
            }
          ],
          skipDuplicates: true
        })
        if (inserted.count === 1) return "new" as const

        const existing = await this.dbClient.cx.usageOperation.findUnique({
          where: {organizationId_operationId: {organizationId: input.organizationId, operationId: input.operationId}}
        })
        if (!existing || existing.requestDigest !== digest) throw new UsageOperationMismatchError()
        return "duplicate" as const
      },
      error => this.mapError(error, "reserve")
    )
  }

  completeOperation(
    input: UsageOperation,
    result: UsageSettlementResult
  ): TE.TaskEither<UsageError, TenantEvent | undefined> {
    return pipe(
      TE.tryCatch<UsageError, {count: number; event: TenantEvent | undefined}>(
        () =>
          this.dbClient.transactional(input.organizationId, async tx => {
            const operation = await tx.usageOperation.findUnique({
              where: {
                organizationId_operationId: {organizationId: input.organizationId, operationId: input.operationId}
              }
            })
            if (!operation || operation.requestDigest !== requestDigest(input)) throw new UsageOperationMismatchError()
            if (operation.status !== "reserved") {
              const actualMatches = result.state !== "settled" || operation.actualUnits === BigInt(result.actualUnits)
              if (operation.status === result.state && actualMatches) return {count: 1, event: undefined}
              throw new UsageOperationMismatchError()
            }
            const update = await tx.usageOperation.updateMany({
              where: {
                organizationId: input.organizationId,
                operationId: input.operationId,
                status: "reserved",
                occ: operation.occ
              },
              data: {
                status: result.state,
                ...(result.state === "settled" ? {actualUnits: BigInt(result.actualUnits)} : {}),
                updatedAt: new Date(),
                occ: {increment: 1}
              }
            })
            if (update.count !== 1) throw new UsageOperationMismatchError()
            const revision = operation.occ + 1n
            await tx.usageSettlementIntent.create({
              data: {
                id: uuidv7(),
                organizationId: input.organizationId,
                operationId: input.operationId,
                revision,
                desiredStatus: result.state,
                ...(result.state === "settled" ? {actualUnits: BigInt(result.actualUnits)} : {}),
                availableAt: new Date(),
                attempts: 0,
                createdAt: new Date()
              }
            })
            const event: TenantEvent = {
              organizationId: input.organizationId,
              schemaVersion: 1,
              eventId: generateDeterministicId(
                `usage-settlement-${input.organizationId}-${input.operationId}-${revision}`
              ),
              type: "usage.settlement",
              operationId: input.operationId,
              operationOcc: revision
            }
            return {...update, event}
          }),
        error => this.mapError(error, "completeOperation")
      ),
      TE.chainW(update => (update.count === 1 ? TE.right(update.event) : TE.left("operation_mismatch" as const)))
    )
  }

  getReservedOperations(
    context: TenantContext,
    limit: number
  ): TE.TaskEither<UsageError, ReadonlyArray<UsageOperation>> {
    if (limit < 1) return TE.left("invalid_usage")
    return TE.tryCatch(
      async () => {
        const rows = await this.dbClient.cx.usageOperation.findMany({
          where: {organizationId: context.organizationId, status: "reserved"},
          orderBy: [{createdAt: "asc"}, {id: "asc"}],
          take: limit
        })
        return rows.map(toUsageOperation)
      },
      error => this.mapError(error, "getReservedOperations")
    )
  }

  getSettlement(
    context: TenantContext,
    operationId: string,
    revision: string
  ): TE.TaskEither<UsageError, UsageSettlement> {
    return TE.tryCatch(
      async () => {
        const intent = await this.dbClient.cx.usageSettlementIntent.findUnique({
          where: {
            organizationId_operationId_revision: {
              organizationId: context.organizationId,
              operationId,
              revision: BigInt(revision)
            }
          }
        })
        if (!intent) throw new UsageOperationMismatchError()
        const operation = await this.dbClient.cx.usageOperation.findUnique({
          where: {organizationId_operationId: {organizationId: context.organizationId, operationId}}
        })
        if (!operation) throw new UsageOperationMismatchError()
        return toUsageSettlement(
          toUsageOperation(operation),
          intent.revision.toString(),
          intent.desiredStatus,
          intent.actualUnits
        )
      },
      error => this.mapError(error, "getSettlement")
    )
  }

  /** Reads a bounded batch of unacknowledged intents with their operations; does not mutate or claim rows. */
  getPendingSettlements(
    context: TenantContext,
    batchSize: number
  ): TE.TaskEither<UsageError, ReadonlyArray<UsageSettlement>> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) return TE.left("invalid_batch_size")
    return TE.tryCatch(
      async () => {
        const intents = await this.dbClient.cx.usageSettlementIntent.findMany({
          where: {organizationId: context.organizationId, appliedAt: null},
          orderBy: [{availableAt: "asc"}, {id: "asc"}],
          take: batchSize
        })
        return Promise.all(
          intents.map(async intent => {
            const operation = await this.dbClient.cx.usageOperation.findUnique({
              where: {
                organizationId_operationId: {organizationId: context.organizationId, operationId: intent.operationId}
              }
            })
            if (!operation) throw new UsageOperationMismatchError()
            return toUsageSettlement(
              toUsageOperation(operation),
              intent.revision.toString(),
              intent.desiredStatus,
              intent.actualUnits
            )
          })
        )
      },
      error => this.mapError(error, "pending settlements")
    )
  }

  acknowledge(context: TenantContext, operationId: string, revision: string): TE.TaskEither<UsageError, void> {
    return TE.tryCatch(
      async () => {
        const existing = await this.dbClient.cx.usageSettlementIntent.findUnique({
          where: {
            organizationId_operationId_revision: {
              organizationId: context.organizationId,
              operationId,
              revision: BigInt(revision)
            }
          },
          select: {appliedAt: true}
        })
        if (!existing) throw new UsageOperationMismatchError()
        if (existing.appliedAt) return
        const updated = await this.dbClient.cx.usageSettlementIntent.updateMany({
          where: {
            organizationId: context.organizationId,
            operationId,
            revision: BigInt(revision),
            appliedAt: null
          },
          data: {appliedAt: new Date()}
        })
        if (updated.count !== 1) {
          const current = await this.dbClient.cx.usageSettlementIntent.findUnique({
            where: {
              organizationId_operationId_revision: {
                organizationId: context.organizationId,
                operationId,
                revision: BigInt(revision)
              }
            },
            select: {appliedAt: true}
          })
          if (!current?.appliedAt) throw new UsageOperationMismatchError()
        }
      },
      error => this.mapError(error, "acknowledge")
    )
  }

  private mapError(error: unknown, operation: string): UsageError {
    if (error instanceof UsageModelError) return error.validationError
    if (error instanceof UsageOperationMismatchError) return "operation_mismatch"
    Logger.error(`Usage operation ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

function requestDigest(input: UsageOperation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        operationId: input.operationId,
        metric: input.metric,
        period: input.period,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: input.actor,
        estimatedUnits: input.estimatedUnits,
        isBillable: input.isBillable
      })
    )
    .digest("hex")
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
}): UsageOperation {
  const result = UsageOperationFactory.validate({
    organizationId: row.organizationId,
    operationId: row.operationId,
    metric: row.metric,
    period: row.period,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: {type: row.actorType, id: row.actorId, displayName: row.actorDisplayName},
    estimatedUnits: Number(row.estimatedUnits),
    isBillable: row.isBillable
  })
  if (E.isLeft(result)) throw new UsageModelError(result.left)
  return result.right
}

function toUsageSettlement(
  operation: UsageOperation,
  revision: string,
  state: string,
  actualUnits: bigint | null
): UsageSettlement {
  const result = UsageSettlementFactory.validate({
    ...operation,
    revision,
    state,
    actualUnits: actualUnits === null ? null : Number(actualUnits)
  })
  if (E.isLeft(result)) throw new UsageModelError(result.left)
  return result.right
}

class UsageOperationMismatchError extends Error {}

class UsageModelError extends Error {
  constructor(readonly validationError: UsageError) {
    super(validationError)
  }
}
