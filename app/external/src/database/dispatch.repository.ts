import {fromPromise, isRetryableTransactionError} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {TenantContext} from "@domain"
import {
  DispatchRepository,
  DispatchWork,
  DispatchWorkFactory,
  DispatchAttempt,
  DispatchAttemptSelector,
  DispatchAttemptFactory,
  WorkError
} from "@services"
import * as E from "fp-ts/Either"
import * as O from "fp-ts/Option"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkerDatabaseClient} from "./capability-database-client"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class DispatchDbRepository implements DispatchRepository {
  constructor(private readonly workers: WorkerDatabaseClient) {}

  getWork(context: TenantContext, taskId: string): TE.TaskEither<WorkError, DispatchWork> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.durableWork.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
            })
          ),
        error => this.mapError(error, "read work")
      ),
      chainNullableToLeft("task_not_found" as const),
      TE.chainEitherKW(work =>
        DispatchWorkFactory.validate({
          ...work,
          // Only an entirely absent lease becomes undefined; partial leases reach the factory and fail validation.
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
    selector: DispatchAttemptSelector
  ): TE.TaskEither<WorkError, O.Option<DispatchAttempt>> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.dispatchAttempt.findUnique({
              where:
                selector.type === "attempt_id"
                  ? {organizationId_id: {organizationId: context.organizationId, id: selector.attemptId}}
                  : {
                      organizationId_taskId_fencing: {
                        organizationId: context.organizationId,
                        taskId: selector.taskId,
                        fencing: selector.fencing
                      }
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
                executingAt: attempt.executingAt ?? undefined,
                completedAt: attempt.completedAt ?? undefined,
                outcomeCategory: attempt.outcomeCategory ?? undefined
              }),
              E.map(O.some)
            )
      )
    )
  }

  countActiveTaskLeases(context: TenantContext, now: Date): TE.TaskEither<WorkError, number> {
    return fromPromise(
      () =>
        this.workers.transactional(context.organizationId, cx =>
          cx.durableWork.count({
            where: {
              organizationId: context.organizationId,
              state: {in: ["claimed", "executing"]},
              leaseUntil: {gt: now}
            }
          })
        ),
      error => this.mapError(error, "count active task leases")
    )
  }

  compareAndSetWork(
    context: TenantContext,
    previous: DispatchWork,
    next: DispatchWork
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, async cx => {
            const expectedLease = persistedDispatchLease(previous.lease)
            const nextLease = persistedDispatchLease(next.lease)
            const updated = await cx.durableWork.updateMany({
              where: {
                organizationId: context.organizationId,
                id: previous.id,
                kind: previous.kind,
                state: previous.state,
                fencing: previous.fencing,
                occ: previous.occ,
                leaseOwner: expectedLease.owner,
                leaseUntil: guardedLeaseUntil(previous, next)
              },
              data: {
                state: next.state,
                leaseOwner: nextLease.owner,
                leaseUntil: nextLease.expiresAt,
                fencing: next.fencing,
                attempts: next.attempts,
                occ: next.occ
              }
            })
            return updated.count === 1 ? E.right(undefined) : E.left("lease_lost" as const)
          }),
        error => this.mapError(error, "update work")
      ),
      TE.chainEitherKW(result => result)
    )
  }

  createAttempt(context: TenantContext, attempt: DispatchAttempt): TE.TaskEither<WorkError, void> {
    return fromPromise(
      () =>
        this.workers.transactional(context.organizationId, async cx => {
          await cx.dispatchAttempt.create({
            data: {
              id: attempt.id,
              organizationId: context.organizationId,
              taskId: attempt.taskId,
              fencing: attempt.fencing,
              state: attempt.state,
              occ: attempt.occ,
              admittedAt: attempt.admittedAt,
              ...persistedAttemptDetails(attempt)
            }
          })
        }),
      error => this.mapError(error, "create attempt")
    )
  }

  compareAndSetAttempt(
    context: TenantContext,
    previous: DispatchAttempt,
    next: DispatchAttempt
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, async cx => {
            const updated = await cx.dispatchAttempt.updateMany({
              where: {
                organizationId: context.organizationId,
                id: previous.id,
                taskId: previous.taskId,
                state: previous.state,
                fencing: previous.fencing,
                occ: previous.occ
              },
              data: {
                state: next.state,
                ...persistedAttemptDetails(next),
                occ: next.occ
              }
            })
            return updated.count === 1
              ? E.right(undefined)
              : E.left("dispatch_attempt_concurrent_modification" as const)
          }),
        error => this.mapError(error, "update attempt")
      ),
      TE.chainEitherKW(result => result)
    )
  }

  private mapError(error: unknown, operation: string): WorkError {
    // The service transaction retries the whole computation, including prior writes.
    if (isRetryableTransactionError(error)) return "repository_dependency_error" as const
    Logger.error(`Dispatch persistence ${operation} failed`, error)
    return "repository_dependency_error"
  }
}

function persistedDispatchLease(lease: DispatchWork["lease"]): {owner: string | null; expiresAt: Date | null} {
  return lease ?? {owner: null, expiresAt: null}
}

/** Recheck live ownership or expired recovery at write time, after matching the original lease. */
// TODO: Pass explicit lease-check intent from the service instead of inferring expired recovery from a fencing change.
function guardedLeaseUntil(previous: DispatchWork, next: DispatchWork) {
  const expiresAt = previous.lease?.expiresAt ?? null
  if (previous.state !== "claimed" && previous.state !== "executing") return expiresAt
  return next.fencing !== previous.fencing ? {equals: expiresAt, lt: new Date()} : {equals: expiresAt, gte: new Date()}
}

function persistedAttemptDetails(attempt: DispatchAttempt) {
  switch (attempt.state) {
    case "admitted":
      return {executingAt: null, completedAt: null, outcomeCategory: null}
    case "executing":
      return {executingAt: attempt.executingAt, completedAt: null, outcomeCategory: null}
    case "succeeded":
    case "retry_due":
    case "failed":
    case "unknown":
      return {
        executingAt: attempt.executingAt ?? null,
        completedAt: attempt.completedAt,
        outcomeCategory: attempt.outcomeCategory
      }
  }
}
