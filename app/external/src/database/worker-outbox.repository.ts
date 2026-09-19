import {Injectable, Logger} from "@nestjs/common"
import {
  WorkerOutboxRepository,
  OutboxClaimCriteria,
  OutboxClaim,
  OutboxClaimCandidate,
  OutboxAcknowledgementState,
  WorkError
} from "@services"
import {Prisma} from "@prisma/client"
import {TenantContext} from "@domain"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkerDatabaseClient} from "./capability-database-client"
import {fromPromise, isRetryableTransactionError} from "./repository-operation"
import {toEvent} from "./shared/outbox-mappers"
import {isPrismaRecordNotFoundError} from "./errors"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_UPPER_BOUND} from "./constants"

@Injectable()
export class WorkerOutboxDbRepository implements WorkerOutboxRepository {
  constructor(private readonly workers: WorkerDatabaseClient) {}

  listClaimCandidates(
    context: TenantContext,
    criteria: OutboxClaimCriteria
  ): TE.TaskEither<WorkError, ReadonlyArray<OutboxClaimCandidate>> {
    const {claimAt, recoveryBefore, batchSize, receiptRecovery} = criteria
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
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.tenantOutbox.findMany({
              where: claimable,
              orderBy: [{availableAt: "asc"}, {id: "asc"}],
              take: batchSize
            })
          ),
        error => {
          if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
          Logger.error(
            "Tenant outbox candidate read failed",
            error instanceof Error ? error.name : "non_error_throwable"
          )
          return "repository_dependency_error" as const
        }
      ),
      TE.chainEitherKW(
        E.traverseArray(candidate =>
          pipe(
            toEvent(candidate),
            E.map(event => ({event, occ: candidate.occ, fencing: candidate.attempts}))
          )
        )
      )
    )
  }

  tryClaim(context: TenantContext, claim: OutboxClaim, occ: bigint): TE.TaskEither<WorkError, boolean> {
    const {event, lease} = claim
    if (lease.fencing < 1n || lease.fencing > POSTGRES_BIGINT_UPPER_BOUND) return TE.left("lease_invalid_fencing")
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.tenantOutbox.update({
              where: {organizationId_eventId: {organizationId: context.organizationId, eventId: event.eventId}, occ},
              data: {
                leaseOwner: lease.owner,
                leaseUntil: lease.expiresAt,
                publishedAt: null,
                attempts: lease.fencing,
                occ: {increment: 1}
              }
            })
          ),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.TenantOutbox)) return "concurrency_error" as const
          if (!isRetryableTransactionError(error))
            Logger.error("Tenant outbox claim failed", error instanceof Error ? error.name : "non_error_throwable")
          return "repository_dependency_error" as const
        }
      ),
      TE.map(() => true),
      TE.orElseW(error => (error === "concurrency_error" ? TE.right(false) : TE.left(error)))
    )
  }

  getAcknowledgementState(
    context: TenantContext,
    eventId: string
  ): TE.TaskEither<WorkError, OutboxAcknowledgementState> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.tenantOutbox.findUnique({
              where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
              select: {leaseOwner: true, leaseUntil: true, publishedAt: true, attempts: true, occ: true}
            })
          ),
        error => {
          if (!isRetryableTransactionError(error))
            Logger.error(
              "Tenant outbox acknowledgement read failed",
              error instanceof Error ? error.name : "non_error_throwable"
            )
          return "repository_dependency_error" as const
        }
      ),
      chainNullableToLeft("event_not_found" as const),
      TE.map(({attempts, ...state}) => ({...state, fencing: attempts}))
    )
  }

  acknowledge(
    context: TenantContext,
    eventId: string,
    acknowledgement: {readonly occ: bigint; readonly acknowledgedAt: Date}
  ): TE.TaskEither<WorkError, boolean> {
    const {occ, acknowledgedAt} = acknowledgement
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.tenantOutbox.update({
              where: {organizationId_eventId: {organizationId: context.organizationId, eventId}, occ},
              data: {publishedAt: acknowledgedAt, leaseOwner: null, leaseUntil: null, occ: {increment: 1}}
            })
          ),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.TenantOutbox)) return "concurrency_error" as const
          if (!isRetryableTransactionError(error))
            Logger.error(
              "Tenant outbox acknowledgement failed",
              error instanceof Error ? error.name : "non_error_throwable"
            )
          return "repository_dependency_error" as const
        }
      ),
      TE.map(() => true),
      TE.orElseW(error => (error === "concurrency_error" ? TE.right(false) : TE.left(error)))
    )
  }
}
