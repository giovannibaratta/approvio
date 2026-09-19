import {fromPromise, isRetryableTransactionError} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {
  TenantContext,
  TenantEvent,
  TenantEventValidationError,
  OutboxPublicationState,
  OutboxPublicationStateFactory
} from "@domain"
import {TenantOutboxRepository, OutboxAppend, WorkError} from "@services"
import * as O from "fp-ts/Option"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import {TenantOutboxTenantClient} from "./tenant-database-clients"
import {toEvent, toPersistenceEnvelope} from "./shared/outbox-mappers"
import {mapToJsonValue} from "./shared/json-mappers"

@Injectable()
export class TenantOutboxDbRepository implements TenantOutboxRepository {
  constructor(private readonly dbClient: TenantOutboxTenantClient) {}

  getEvent(
    context: TenantContext,
    eventId: string
  ): TE.TaskEither<
    "event_not_found" | "event_mismatch" | TenantEventValidationError | "repository_dependency_error",
    TenantEvent
  > {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.tenantOutbox.findUnique({
            where: {organizationId_eventId: {organizationId: context.organizationId, eventId}}
          }),
        error => {
          // Preserve the cause for whole-transaction retries; the transaction manager maps exhaustion to Left.
          if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
          Logger.error("Tenant outbox read failed", error instanceof Error ? error.name : "non_error_throwable")
          return "repository_dependency_error" as const
        }
      ),
      TE.chainW(row => (row ? TE.fromEither(toEvent(row)) : TE.left("event_not_found" as const)))
    )
  }

  append(context: TenantContext, input: OutboxAppend): TE.TaskEither<"repository_dependency_error", boolean> {
    const {event, createdAt, availableAt, attempts, occ} = input
    const envelope = toPersistenceEnvelope(event)
    return fromPromise(
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
              resourceVersion: envelope.resourceVersion ?? null,
              payload: mapToJsonValue(event),
              availableAt,
              attempts,
              occ,
              createdAt
            }
          ],
          skipDuplicates: true
        })
        return inserted.count === 1
      },
      error => {
        // Preserve the cause for whole-transaction retries; the transaction manager maps exhaustion to Left.
        if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
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
      fromPromise(
        () =>
          this.dbClient.cx.tenantOutbox.findUnique({
            where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
            select: {publishedAt: true, leaseOwner: true, leaseUntil: true}
          }),
        error => {
          if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
          Logger.error(
            "Tenant outbox publication read failed",
            error instanceof Error ? error.name : "non_error_throwable"
          )
          return "repository_dependency_error" as const
        }
      ),
      TE.chainEitherKW(row =>
        pipe(
          O.fromNullable(row),
          O.traverse(E.Applicative)(value => OutboxPublicationStateFactory.validate(value))
        )
      )
    )
  }

  tryMarkPublished(context: TenantContext, eventId: string, publishedAt: Date): TE.TaskEither<WorkError, boolean> {
    return fromPromise(
      async () => {
        const update = await this.dbClient.cx.tenantOutbox.updateMany({
          where: {
            organizationId: context.organizationId,
            eventId,
            publishedAt: null,
            leaseOwner: null,
            leaseUntil: null
          },
          data: {publishedAt, occ: {increment: 1}}
        })
        return update.count === 1
      },
      error => {
        if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
        Logger.error("Tenant outbox publication failed", error instanceof Error ? error.name : "non_error_throwable")
        return "repository_dependency_error" as const
      }
    )
  }
}
