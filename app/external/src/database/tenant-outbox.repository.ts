import {Injectable, Logger} from "@nestjs/common"
import {TaskReadyEvent, TenantContext, TenantEvent, TenantEventFactory, TenantEventValidationError} from "@domain"
import {
  OutboxRepository,
  OutboxAppend,
  OutboxClaimCriteria,
  OutboxPublicationState,
  OutboxClaim,
  OutboxClaimFactory,
  WorkError
} from "@services"
import {Prisma, TenantOutbox} from "@prisma/client"
import * as O from "fp-ts/Option"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import {TenantOutboxTenantClient} from "./tenant-database-clients"
import {DatabaseClient} from "./database-client"
import {WorkerDatabaseClient} from "./capability-database-client"
import {mapToJsonValue} from "./shared/json-mappers"

@Injectable()
export class TenantOutboxDbRepository implements OutboxRepository {
  constructor(
    private readonly dbClient: TenantOutboxTenantClient,
    private readonly workers: WorkerDatabaseClient
  ) {}

  getEvent(
    context: TenantContext,
    eventId: string
  ): TE.TaskEither<
    "event_not_found" | "event_mismatch" | TenantEventValidationError | "repository_dependency_error",
    TenantEvent
  > {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.tenantOutbox.findUnique({
            where: {organizationId_eventId: {organizationId: context.organizationId, eventId}}
          }),
        error => {
          // Preserve the cause for whole-transaction retries; the transaction manager maps exhaustion to Left.
          if (DatabaseClient.isRetryableTransactionError(error)) throw error
          Logger.error("Tenant outbox read failed", error instanceof Error ? error.name : "non_error_throwable")
          return "repository_dependency_error" as const
        }
      ),
      TE.chainW(row => (row ? TE.fromEither(toEvent(row)) : TE.left("event_not_found" as const)))
    )
  }

  append(context: TenantContext, input: OutboxAppend): TE.TaskEither<"repository_dependency_error", boolean> {
    const {event, createdAt, availableAt, attempts} = input
    const envelope = toPersistenceEnvelope(event)
    return TE.tryCatch(
      async () => {
        const inserted = await this.dbClient.cx.tenantOutbox.createMany({
          data: [
            {
              id: uuidv7(),
              organizationId: context.organizationId,
              eventId: event.eventId,
              eventType: event.type,
              schemaVersion: event.schemaVersion,
              resourceId: envelope.resourceId,
              resourceVersion: envelope.resourceVersion,
              payload: mapToJsonValue(event),
              availableAt,
              attempts,
              createdAt
            }
          ],
          skipDuplicates: true
        })
        return inserted.count === 1
      },
      error => {
        // Preserve the cause for whole-transaction retries; the transaction manager maps exhaustion to Left.
        if (DatabaseClient.isRetryableTransactionError(error)) throw error
        Logger.error("Tenant outbox append failed", error instanceof Error ? error.name : "non_error_throwable")
        return "repository_dependency_error" as const
      }
    )
  }

  getPublicationState(
    context: TenantContext,
    eventId: string
  ): TE.TaskEither<WorkError, O.Option<OutboxPublicationState>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.tenantOutbox.findUnique({
              where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
              select: {publishedAt: true, leaseOwner: true, leaseUntil: true}
            })
          ),
        error => {
          if (DatabaseClient.isRetryableTransactionError(error)) throw error
          Logger.error(
            "Tenant outbox publication read failed",
            error instanceof Error ? error.name : "non_error_throwable"
          )
          return "repository_dependency_error" as const
        }
      ),
      TE.map(O.fromNullable)
    )
  }

  tryMarkPublished(context: TenantContext, eventId: string, publishedAt: Date): TE.TaskEither<WorkError, boolean> {
    return TE.tryCatch(
      () =>
        this.workers.transactional(context.organizationId, async cx => {
          const update = await cx.tenantOutbox.updateMany({
            where: {
              organizationId: context.organizationId,
              eventId,
              publishedAt: null,
              leaseOwner: null,
              leaseUntil: null
            },
            data: {publishedAt}
          })
          return update.count === 1
        }),
      error => {
        if (DatabaseClient.isRetryableTransactionError(error)) throw error
        Logger.error("Tenant outbox publication failed", error instanceof Error ? error.name : "non_error_throwable")
        return "repository_dependency_error" as const
      }
    )
  }

  claim(context: TenantContext, criteria: OutboxClaimCriteria): TE.TaskEither<WorkError, ReadonlyArray<OutboxClaim>> {
    const {owner, claimAt, recoveryBefore, leaseUntil, batchSize, receiptRecovery} = criteria
    const claimable: Prisma.TenantOutboxWhereInput = {
      organizationId: context.organizationId,
      availableAt: {lte: claimAt},
      AND: [
        {OR: [{leaseUntil: null}, {leaseUntil: {lt: claimAt}}]},
        {
          OR: [
            {publishedAt: null, createdAt: {lte: recoveryBefore}},
            ...receiptRecovery.map(({eventType, consumer}) => ({
              eventType,
              publishedAt: {lte: recoveryBefore},
              tenantEventReceipts: {none: {consumer}}
            }))
          ]
        }
      ]
    }
    return pipe(
      TE.tryCatch(
        () =>
          this.workers.transactional(context.organizationId, async cx => {
            const candidates = await cx.tenantOutbox.findMany({
              where: claimable,
              orderBy: [{availableAt: "asc"}, {id: "asc"}],
              take: batchSize
            })
            const claimed: TenantOutbox[] = []
            for (const candidate of candidates) {
              const update = await cx.tenantOutbox.updateMany({
                where: {...claimable, id: candidate.id, attempts: candidate.attempts},
                data: {leaseOwner: owner, leaseUntil, publishedAt: null, attempts: {increment: 1}}
              })

              // A competing writer may have changed eligibility since candidate selection.
              if (update.count !== 1) continue
              claimed.push(candidate)
            }
            return claimed
          }),
        error => {
          if (DatabaseClient.isRetryableTransactionError(error)) throw error
          Logger.error("Tenant outbox claim failed", error instanceof Error ? error.name : "non_error_throwable")
          return "repository_dependency_error" as const
        }
      ),
      TE.chainEitherKW(
        E.traverseArray(candidate =>
          pipe(
            toEvent(candidate),
            E.chainW(event =>
              OutboxClaimFactory.validate({
                event,
                lease: {owner, fencing: BigInt(candidate.attempts + 1), expiresAt: leaseUntil}
              })
            )
          )
        )
      )
    )
  }

  acknowledge(
    context: TenantContext,
    eventId: string,
    acknowledgement: {readonly owner: string; readonly fencing: number; readonly acknowledgedAt: Date}
  ): TE.TaskEither<WorkError, boolean> {
    const {owner, fencing, acknowledgedAt} = acknowledgement
    return TE.tryCatch(
      () =>
        this.workers.transactional(context.organizationId, async cx => {
          const update = await cx.tenantOutbox.updateMany({
            where: {
              organizationId: context.organizationId,
              eventId,
              leaseOwner: owner,
              attempts: fencing,
              publishedAt: null,
              leaseUntil: {gte: acknowledgedAt}
            },
            data: {publishedAt: acknowledgedAt, leaseOwner: null, leaseUntil: null}
          })
          return update.count === 1
        }),
      error => {
        if (DatabaseClient.isRetryableTransactionError(error)) throw error
        Logger.error(
          "Tenant outbox acknowledgement failed",
          error instanceof Error ? error.name : "non_error_throwable"
        )
        return "repository_dependency_error" as const
      }
    )
  }
}

type PersistenceEnvelope = {readonly resourceId: string; readonly resourceVersion: bigint}

function toPersistenceEnvelope(event: TenantEvent): PersistenceEnvelope {
  if (event.type === "task.ready") return {resourceId: event.taskId, resourceVersion: event.taskOcc}
  if (event.type === "workflow.recalculate") return {resourceId: event.workflowId, resourceVersion: 0n}
  if (event.type === "workflow.status_changed")
    return {resourceId: event.workflowId, resourceVersion: event.workflowOcc}
  if (event.type === "usage.settlement") return {resourceId: event.operationId, resourceVersion: event.operationOcc}
  return {resourceId: event.organizationId, resourceVersion: 0n}
}

function toEvent(
  row: TenantOutbox
): E.Either<"event_mismatch" | TenantEventValidationError, TenantEvent | TaskReadyEvent> {
  const event = TenantEventFactory.validate(row.payload)
  if (E.isLeft(event)) return event
  // Identity, type and version fields are duplicated in columns for database queries and constraints.
  // The factory validates only the JSON payload; these checks ensure both copies remain consistent.
  const envelope = toPersistenceEnvelope(event.right)
  if (
    event.right.organizationId !== row.organizationId ||
    event.right.eventId !== row.eventId ||
    event.right.type !== row.eventType ||
    event.right.schemaVersion !== row.schemaVersion ||
    envelope.resourceId !== row.resourceId ||
    envelope.resourceVersion !== row.resourceVersion
  )
    return E.left("event_mismatch")
  return event
}
