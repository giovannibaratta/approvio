import {Inject, Injectable} from "@nestjs/common"
import {Lease, TaskKind, TenantContext} from "@domain"
import {ConfigProvider} from "@external/config"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import {
  DispatchRepository,
  DISPATCH_REPOSITORY_TOKEN,
  WorkError,
  DispatchClaim,
  DispatchClaimFactory,
  DispatchCompletion
} from "./interfaces"
import {DispatchTransitionFactory, DispatchTransitionResult, DispatchWork, DispatchAttempt} from "./dispatch.models"
import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"

@Injectable()
export class DispatchService {
  constructor(
    @Inject(DISPATCH_REPOSITORY_TOKEN) private readonly dispatchRepository: DispatchRepository,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly transactions: TenantTransactionManager,
    @Inject(ConfigProvider) private readonly config: Pick<ConfigProvider, "dispatchConfig">
  ) {}

  recoverExpired(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    evaluateAt: Date
  ): TE.TaskEither<WorkError, DispatchWork> {
    return this.transactions.execute(context, () =>
      pipe(
        this.dispatchRepository.getWork(context, taskId, kind),
        TE.chainW(work => this.recoverWork(context, work, evaluateAt))
      )
    )
  }

  private recoverWork(
    context: TenantContext,
    work: DispatchWork,
    evaluateAt: Date
  ): TE.TaskEither<WorkError, DispatchWork> {
    if (work.state === "unknown") return TE.left("dispatch_recovery_already_unknown")
    if (work.state !== "claimed" && work.state !== "executing") return TE.left("dispatch_recovery_not_applicable")
    if (work.lease === undefined) return TE.left("dispatch_work_invalid_lease")
    if (work.lease.expiresAt >= evaluateAt) return TE.left("dispatch_lease_not_expired")
    // Share the evaluation time between expiry selection and the domain recovery.
    return pipe(
      this.dispatchRepository.getAttempt(context, {taskId: work.id, fencing: work.fencing}),
      TE.chainW(TE.fromOption(() => "dispatch_attempt_not_found" as const)),
      TE.bindTo("attempt"),
      TE.bindW("next", ({attempt}) => TE.fromEither(DispatchTransitionFactory.recover(work, attempt, evaluateAt))),
      TE.chainFirstW(({attempt, next}) => this.dispatchRepository.persistTransition(context, {work, attempt}, next)),
      TE.map(({next}) => next.work)
    )
  }

  claim(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    evaluateAt: Date
  ): TE.TaskEither<WorkError, DispatchClaim> {
    if (!owner.trim()) return TE.left("lease_invalid_owner")
    // Cache atomically reserves dispatch capacity before this database admission.
    // The database count is a fallback when cache loses occupancy records while
    // earlier actions are still running. Under Read Committed, simultaneous claims
    // can both observe a free slot; temporary overshoot is an accepted trade-off
    // for avoiding Serializable conflict tracking and retries across task rows.
    // OCC, fencing and lease predicates still protect each individual task claim.
    return this.transactions.execute(
      context,
      () =>
        pipe(
          this.dispatchRepository.getWork(context, taskId, kind),
          TE.bindTo("work"),
          TE.bindW("next", ({work}) => TE.fromEither(this.createClaimTransition(work, owner, evaluateAt))),
          TE.bindW("claim", ({next}) => TE.fromEither(this.createClaimHandle(next))),
          TE.chainFirstW(() => this.ensureDispatchCapacity(context, evaluateAt)),
          TE.chainFirstW(({work, next}) => this.dispatchRepository.persistTransition(context, {work}, next)),
          TE.map(({claim}) => claim)
        ),
      {isolationLevel: "ReadCommitted"}
    )
  }

  private createClaimTransition(
    work: DispatchWork,
    owner: string,
    evaluateAt: Date
  ): E.Either<WorkError, DispatchTransitionResult> {
    const expiresAt = new Date(evaluateAt.getTime() + this.config.dispatchConfig.leaseDurationMs)
    const attemptId = uuidv7()
    return DispatchTransitionFactory.claim(work, owner, evaluateAt, expiresAt, attemptId)
  }

  private createClaimHandle(next: DispatchTransitionResult): E.Either<WorkError, DispatchClaim> {
    if (next.attempt === undefined) return E.left("dispatch_attempt_not_found")
    if (next.work.lease === undefined) return E.left("lease_lost")

    return DispatchClaimFactory.validate({
      attemptId: next.attempt.id,
      lease: {...next.work.lease, fencing: next.work.fencing},
      occ: next.attempt.occ
    })
  }

  private ensureDispatchCapacity(context: TenantContext, evaluateAt: Date): TE.TaskEither<WorkError, void> {
    return pipe(
      this.dispatchRepository.countActiveTaskLeases(context, evaluateAt),
      TE.chainW(activeTaskLeases =>
        activeTaskLeases >= this.config.dispatchConfig.concurrencyPerOrganization
          ? TE.left("capacity_exceeded" as const)
          : TE.right(undefined)
      )
    )
  }

  parkReady(context: TenantContext, taskId: string, kind: TaskKind): TE.TaskEither<WorkError, void> {
    return this.transactions.execute(context, () =>
      pipe(
        this.dispatchRepository.getWork(context, taskId, kind),
        TE.chainW(work =>
          work.state === "paused"
            ? TE.left("dispatch_work_already_paused" as const)
            : this.persist(context, {work}, DispatchTransitionFactory.pauseReady(work))
        )
      )
    )
  }

  parkAttempt(context: TenantContext, attemptId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    return this.withAttempt(context, attemptId, (work, attempt) =>
      this.persist(context, {work, attempt}, DispatchTransitionFactory.pauseAttempt(work, attempt, lease))
    )
  }

  validateAttemptLease(context: TenantContext, attemptId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    return this.withAttempt(context, attemptId, (work, attempt) =>
      TE.fromEither(DispatchTransitionFactory.validateAttemptLease(work, attempt, lease))
    )
  }

  startExecution(context: TenantContext, attemptId: string, lease: Lease): TE.TaskEither<WorkError, void> {
    return this.withAttempt(context, attemptId, (work, attempt) =>
      this.persist(context, {work, attempt}, DispatchTransitionFactory.startExecution(work, attempt, lease))
    )
  }

  complete(
    context: TenantContext,
    attemptId: string,
    lease: Lease,
    completion: DispatchCompletion,
    eventId: string
  ): TE.TaskEither<WorkError, void> {
    return this.withAttempt(context, attemptId, (work, attempt) =>
      pipe(
        TE.fromEither(DispatchTransitionFactory.complete(work, attempt, lease, completion)),
        TE.chainFirstW(next => this.dispatchRepository.persistTransition(context, {work, attempt}, next)),
        // A failed attempt before execution leaves the task retryable; do not
        // acknowledge its event until the resulting work no longer needs a retry.
        TE.chainW(next =>
          next.work.state !== "retry_due"
            ? this.dispatchRepository.recordReceipt(context, eventId)
            : TE.right(undefined)
        )
      )
    )
  }

  private persist(
    context: TenantContext,
    previous: DispatchTransitionResult,
    transition: E.Either<WorkError, DispatchTransitionResult>
  ): TE.TaskEither<WorkError, void> {
    return pipe(
      TE.fromEither(transition),
      TE.chainW(value => this.dispatchRepository.persistTransition(context, previous, value))
    )
  }

  private withAttempt<T>(
    context: TenantContext,
    attemptId: string,
    computation: (work: DispatchWork, attempt: DispatchAttempt) => TE.TaskEither<WorkError, T>
  ): TE.TaskEither<WorkError, T> {
    return this.transactions.execute(context, () =>
      pipe(
        this.dispatchRepository.getAttempt(context, {attemptId}),
        TE.chainW(TE.fromOption(() => "dispatch_attempt_not_found" as const)),
        TE.bindTo("attempt"),
        TE.bindW("work", ({attempt}) => this.dispatchRepository.getWork(context, attempt.taskId)),
        TE.chainW(({work, attempt}) => computation(work, attempt))
      )
    )
  }
}
