import {Injectable, Logger} from "@nestjs/common"
import {TaskKind, TenantContext} from "@domain"
import {
  DispatchRepository,
  DispatchWork,
  DispatchWorkFactory,
  DispatchAttempt,
  DispatchAttemptFactory,
  DispatchTransitionResult,
  WorkError
} from "@services"
import * as E from "fp-ts/Either"
import * as O from "fp-ts/Option"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DatabaseClient} from "./database-client"
import {WorkerDatabaseClient} from "./capability-database-client"

@Injectable()
export class DispatchDbRepository implements DispatchRepository {
  constructor(private readonly workers: WorkerDatabaseClient) {}

  getWork(context: TenantContext, taskId: string, kind?: TaskKind): TE.TaskEither<WorkError, DispatchWork> {
    return pipe(
      TE.tryCatch(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.durableWork.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
            })
          ),
        error => this.mapError(error, "read work")
      ),
      TE.chainEitherKW(work =>
        work === null || (kind !== undefined && work.kind !== kind)
          ? E.left("task_not_found" as const)
          : DispatchWorkFactory.validate({
              ...work,
              state: work.state === "sending" ? "executing" : work.state,
              lease:
                work.leaseOwner === null && work.leaseUntil === null
                  ? undefined
                  : {owner: work.leaseOwner, expiresAt: work.leaseUntil}
            })
      )
    )
  }
  getAttempt(
    context: TenantContext,
    selector: {readonly attemptId: string} | {readonly taskId: string; readonly fencing: bigint}
  ): TE.TaskEither<WorkError, O.Option<DispatchAttempt>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.dispatchAttempt.findFirst({
              where: {
                organizationId: context.organizationId,
                ...("attemptId" in selector
                  ? {id: selector.attemptId}
                  : {durableWorkId: selector.taskId, fencing: selector.fencing})
              }
            })
          ),
        error => this.mapError(error, "read attempt")
      ),
      TE.chainEitherKW(attempt =>
        attempt === null
          ? E.right(O.none)
          : pipe(
              DispatchAttemptFactory.validate({
                ...attempt,
                taskId: attempt.durableWorkId,
                executingAt: attempt.sendingAt ?? undefined,
                completedAt: attempt.completedAt ?? undefined,
                outcomeCategory: attempt.outcomeCategory ?? undefined,
                state: attempt.state === "sending" ? "executing" : attempt.state
              }),
              E.map(O.some)
            )
      )
    )
  }
  countActiveTaskLeases(context: TenantContext, now: Date): TE.TaskEither<WorkError, number> {
    return TE.tryCatch(
      () =>
        this.workers.transactional(context.organizationId, cx =>
          cx.durableWork.count({
            where: {organizationId: context.organizationId, state: {in: ["claimed", "sending"]}, leaseUntil: {gt: now}}
          })
        ),
      error => this.mapError(error, "count active task leases")
    )
  }
  persistTransition(
    context: TenantContext,
    previous: DispatchTransitionResult,
    next: DispatchTransitionResult
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.workers.transactional<E.Either<"lease_lost" | "dispatch_attempt_concurrent_modification", void>>(
            context.organizationId,
            async cx => {
              const expected = previous.work
              const expectedLease = persistedDispatchLease(expected.lease)
              const nextLease = persistedDispatchLease(next.work.lease)
              const leaseUntil = guardedLeaseUntil(previous.work, next.work)
              const updated = await cx.durableWork.updateMany({
                where: {
                  organizationId: context.organizationId,
                  id: expected.id,
                  kind: expected.kind,
                  state: persistedDispatchState(expected.state),
                  fencing: expected.fencing,
                  occ: expected.occ,
                  leaseOwner: expectedLease.owner,
                  leaseUntil
                },
                data: {
                  state: persistedDispatchState(next.work.state),
                  leaseOwner: nextLease.owner,
                  leaseUntil: nextLease.expiresAt,
                  fencing: next.work.fencing,
                  attempts: next.work.attempts,
                  occ: next.work.occ
                }
              })
              if (updated.count !== 1) return E.left("lease_lost" as const)
              const attempt = next.attempt
              if (attempt === undefined) return E.right(undefined)
              if (previous.attempt === undefined) {
                await cx.dispatchAttempt.create({
                  data: {
                    id: attempt.id,
                    organizationId: context.organizationId,
                    durableWorkId: attempt.taskId,
                    fencing: attempt.fencing,
                    state: persistedDispatchState(attempt.state),
                    occ: attempt.occ,
                    admittedAt: attempt.admittedAt,
                    ...persistedAttemptDetails(attempt)
                  }
                })
                return E.right(undefined)
              }
              const result = await cx.dispatchAttempt.updateMany({
                where: {
                  organizationId: context.organizationId,
                  id: previous.attempt.id,
                  durableWorkId: expected.id,
                  state: persistedDispatchState(previous.attempt.state),
                  fencing: previous.attempt.fencing,
                  occ: previous.attempt.occ
                },
                data: {
                  state: persistedDispatchState(attempt.state),
                  ...persistedAttemptDetails(attempt),
                  occ: attempt.occ
                }
              })
              return result.count === 1
                ? E.right(undefined)
                : E.left("dispatch_attempt_concurrent_modification" as const)
            }
          ),
        error => this.mapError(error, "persist transition")
      ),
      TE.chainEitherKW(result => result)
    )
  }
  recordReceipt(context: TenantContext, eventId: string): TE.TaskEither<WorkError, void> {
    return TE.tryCatch(
      () =>
        this.workers.transactional(context.organizationId, async cx => {
          const event = await cx.tenantOutbox.findUnique({
            where: {organizationId_eventId: {organizationId: context.organizationId, eventId}},
            select: {eventId: true}
          })
          if (event !== null) await cx.eventReceipts.record("task_dispatch", eventId)
        }),
      error => this.mapError(error, "record receipt")
    )
  }
  private mapError(error: unknown, operation: string): WorkError {
    // The service transaction retries the whole computation, including prior writes.
    if (DatabaseClient.isRetryableTransactionError(error)) throw error
    Logger.error(`Dispatch persistence ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

/** Keep the existing database state name at the SQL boundary, including OCC predicates. */
function persistedDispatchState(state: DispatchWork["state"] | DispatchAttempt["state"]): string {
  return state === "executing" ? "sending" : state
}

function persistedDispatchLease(lease: DispatchWork["lease"]): {owner: string | null; expiresAt: Date | null} {
  return lease ?? {owner: null, expiresAt: null}
}

/** Recheck live ownership or expired recovery at write time, after matching the original lease. */
function guardedLeaseUntil(previous: DispatchWork, next: DispatchWork) {
  const expiresAt = previous.lease?.expiresAt ?? null
  if (previous.state !== "claimed" && previous.state !== "executing") return expiresAt
  return next.fencing !== previous.fencing ? {equals: expiresAt, lt: new Date()} : {equals: expiresAt, gte: new Date()}
}

function persistedAttemptDetails(attempt: DispatchAttempt) {
  switch (attempt.state) {
    case "admitted":
      return {sendingAt: null, completedAt: null, outcomeCategory: null}
    case "executing":
      return {sendingAt: attempt.executingAt, completedAt: null, outcomeCategory: null}
    default:
      return {
        sendingAt: attempt.executingAt ?? null,
        completedAt: attempt.completedAt,
        outcomeCategory: attempt.outcomeCategory
      }
  }
}
