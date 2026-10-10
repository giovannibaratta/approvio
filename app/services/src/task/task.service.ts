import {DispatchService} from "../durable-work/dispatch.service"
import {TenantOutboxService} from "../durable-work/tenant-outbox.service"
import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {
  TASK_REPOSITORY_TOKEN,
  TaskCreateError,
  TaskGetErrorWebhookTask,
  TaskGetErrorEmailTask,
  TaskGetErrorSlackTask,
  TaskCreateRequest,
  TaskRepository,
  TaskUpdateChecks,
  TaskUpdateError,
  TaskGenerationRequest
} from "./interfaces"
import {
  DecoratedWorkflowActionWebhookPendingTask,
  DecoratedWorkflowActionSlackPendingTask,
  Occ,
  WorkflowActionTaskDecoratorSelector
} from "@domain"
import {
  DecoratedWorkflowActionEmailTask,
  WorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  DecoratedWorkflowActionSlackTask,
  TenantContext,
  TaskReadyEvent
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {isLeft} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {v7 as uuidv7} from "uuid"
import {bestEffort} from "@utils"
import {QueueService} from "../queue"
import {Lease, TaskKind} from "@domain"
import {
  DISPATCH_LEASE_CLIENT_TOKEN,
  DispatchLeaseClient,
  WorkError,
  DispatchClaimResult,
  DispatchClaimResultFactory,
  DispatchCompletion,
  DispatchOutcome,
  DispatchCompletionFactory
} from "../durable-work/interfaces"

import {ORGANIZATION_STATUS_REPOSITORY_TOKEN, OrganizationStatusRepository} from "../tenancy/interfaces"

@Injectable()
export class TaskService {
  constructor(
    private readonly tenantOutbox: TenantOutboxService,
    @Inject(TASK_REPOSITORY_TOKEN)
    private readonly taskRepo: TaskRepository,
    private readonly dispatch: DispatchService,
    private readonly queue: QueueService,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly workerTransactions: TenantTransactionManager,
    @Inject(ORGANIZATION_STATUS_REPOSITORY_TOKEN) private readonly organizationStatus: OrganizationStatusRepository,
    @Inject(DISPATCH_LEASE_CLIENT_TOKEN) private readonly capacity: DispatchLeaseClient
  ) {}

  /** Owns delivery capacity through task loading, egress and durable outcome recording. */
  withDispatchLease(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    operation: DispatchOperation
  ): Promise<void> {
    // Each execution has a distinct capacity owner, even when it uses the same worker ID.
    // Redis operations stay outside database transactions and their retry loops.
    const acquire = pipe(
      this.capacity.acquire(context, taskId, uuidv7()),
      TE.mapLeft(error => new Error(`Dispatch capacity admission failed: ${error}`))
    )
    return pipe(
      TE.bracket(
        acquire,
        capacity => this.runDispatch(context, taskId, kind, owner, capacity, operation),
        capacity => this.releaseDispatchCapacity(context, taskId, capacity)
      ),
      TE.matchW(
        error => {
          throw error
        },
        value => value
      )
    )()
  }

  private runDispatch(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    capacity: Lease,
    operation: DispatchOperation
  ): TaskEither<unknown, void> {
    const dispatch = pipe(
      this.claimDispatch(context, taskId, kind, owner, new Date()),
      TE.mapLeft(error => new Error(`Dispatch admission failed: ${error}`)),
      TE.chainW(claim =>
        claim.state === "parked"
          ? TE.right(undefined)
          : this.runDispatchOperation(context, taskId, capacity, claim, operation)
      )
    )
    // Repository exceptions must also reach bracket's release path.
    return pipe(
      TE.tryCatch(
        () => dispatch(),
        error => error
      ),
      TE.chainEitherKW(result => result)
    )
  }

  private runDispatchOperation(
    context: TenantContext,
    taskId: string,
    capacity: Lease,
    claim: Extract<DispatchClaimResult, {state: "admitted"}>,
    operation: DispatchOperation
  ): TaskEither<unknown, void> {
    return TE.tryCatch(
      () => operation(claim, () => this.assertDispatchLease(context, taskId, capacity, claim)),
      error => error
    )
  }

  private assertDispatchLease(
    context: TenantContext,
    taskId: string,
    capacity: Lease,
    claim: Extract<DispatchClaimResult, {state: "admitted"}>
  ): Promise<void> {
    return pipe(
      this.capacity.assertLease(context, taskId, capacity),
      TE.chain(() => this.dispatch.validateAttemptLease(context, claim.attemptId, claim.lease)),
      TE.match(
        error => {
          throw new Error(`Dispatch lease check failed: ${error}`)
        },
        () => undefined
      )
    )()
  }

  private releaseDispatchCapacity(context: TenantContext, taskId: string, capacity: Lease): TaskEither<never, void> {
    return async () => {
      // Cleanup must preserve the delivery result even if Redis throws; its lease expires naturally.
      try {
        const released = await this.capacity.release(context, taskId, capacity)()
        if (isLeft(released)) Logger.warn(`Dispatch capacity release failed for ${taskId}: ${released.left}`)
      } catch (error) {
        Logger.warn(`Dispatch capacity release failed for ${taskId}`, error)
      }
      return E.right(undefined)
    }
  }

  claimDispatch(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    now: Date
  ): TaskEither<WorkError, DispatchClaimResult> {
    // Match DispatchService.claim's Read Committed isolation: Redis provides
    // atomic capacity admission, and concurrent database-count overshoot is accepted.
    // An outer Serializable transaction would retain the overhead of a strict cap.
    return this.workerTransactions.execute(
      context,
      () =>
        pipe(
          this.dispatch.recoverExpired(context, taskId, kind, now),
          TE.matchEW(
            error => this.handleDispatchRecoveryError(context, taskId, kind, owner, now, error),
            work => this.admitDispatch(context, taskId, kind, owner, now, work.state === "unknown")
          )
        ),
      {isolationLevel: "ReadCommitted"}
    )
  }

  private handleDispatchRecoveryError(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    evaluateAt: Date,
    error: WorkError
  ): TaskEither<WorkError, DispatchClaimResult> {
    switch (error) {
      case "dispatch_recovery_already_unknown":
        return this.admitDispatch(context, taskId, kind, owner, evaluateAt, true)
      case "dispatch_recovery_not_applicable":
        // No expired execution to recover; normal claim guards decide eligibility.
        return this.admitDispatch(context, taskId, kind, owner, evaluateAt, false)
      case "dispatch_lease_not_expired":
        return TE.left("lease_lost")
      default:
        return TE.left(error)
    }
  }

  private admitDispatch(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    evaluateAt: Date,
    deliveryUnknown: boolean
  ): TaskEither<WorkError, DispatchClaimResult> {
    return pipe(
      this.organizationStatus.getStatus(context),
      TE.chainW((status): TaskEither<WorkError, DispatchClaimResult> => {
        if (deliveryUnknown && (kind !== "webhook" || status !== "active"))
          return TE.fromEither(DispatchClaimResultFactory.validate({state: "parked"}))
        if (status === "active")
          return pipe(
            this.dispatch.claim(context, taskId, kind, owner, evaluateAt),
            TE.chainEitherKW(claim => DispatchClaimResultFactory.validate({state: "admitted", ...claim}))
          )
        return pipe(
          this.dispatch.parkReady(context, taskId, kind),
          // The desired admission disposition is already satisfied; no pause was performed.
          TE.orElseW(error => (error === "dispatch_work_already_paused" ? TE.right(undefined) : TE.left(error))),
          TE.chainEitherKW(() => DispatchClaimResultFactory.validate({state: "parked"}))
        )
      })
    )
  }

  startDispatchExecution(
    context: TenantContext,
    attemptId: string,
    lease: Lease
  ): TaskEither<WorkError, "executing" | "parked"> {
    return this.workerTransactions.execute(context, () =>
      pipe(
        this.organizationStatus.getStatus(context),
        TE.chainW(status =>
          status === "active"
            ? pipe(
                this.dispatch.startExecution(context, attemptId, lease),
                TE.map(() => "executing" as const)
              )
            : pipe(
                this.dispatch.parkAttempt(context, attemptId, lease),
                TE.map(() => "parked" as const)
              )
        )
      )
    )
  }

  completeDispatch(
    context: TenantContext,
    attemptId: string,
    lease: Lease,
    result: {readonly state: DispatchCompletion["state"]; readonly outcome: DispatchOutcome},
    eventId: string
  ): TaskEither<WorkError, void> {
    return pipe(
      TE.fromEither(DispatchCompletionFactory.validate(result)),
      TE.chainW(completion => this.dispatch.complete(context, attemptId, lease, completion, eventId))
    )
  }

  createEventTasks(
    context: TenantContext,
    eventId: string,
    requests: ReadonlyArray<TaskGenerationRequest>
  ): TaskEither<TaskCreateError, "new" | "duplicate"> {
    return pipe(
      this.taskRepo.createEventTasks(context, eventId, requests),
      TE.chainFirstTaskK(
        ({events}) =>
          () =>
            Promise.all(events.map(event => this.publishCommittedTask(context, event)()))
      ),
      TE.map(({outcome}) => outcome)
    )
  }

  createEmailTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionEmailTask<{occ: true}>>
  ): TaskEither<TaskCreateError, void> {
    return pipe(
      this.taskRepo.createEmailTask(context, request),
      bestEffort(
        (event: TaskReadyEvent) => this.publishCommittedTask(context, event),
        (error, event) => Logger.warn(`Task event delivery failed for ${event.eventId}`, String(error))
      ),
      TE.map(() => undefined)
    )
  }

  updateEmailTask(
    context: TenantContext,
    task: WorkflowActionEmailTask,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ> {
    return this.taskRepo.updateEmailTask(context, task, checks)
  }

  createWebhookTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionWebhookPendingTask<{occ: true}>>
  ): TaskEither<TaskCreateError, void> {
    return pipe(
      this.taskRepo.createWebhookTask(context, request),
      bestEffort(
        (event: TaskReadyEvent) => this.publishCommittedTask(context, event),
        (error, event) => Logger.warn(`Task event delivery failed for ${event.eventId}`, String(error))
      ),
      TE.map(() => undefined)
    )
  }

  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ> {
    return this.taskRepo.updateWebhookTask(context, task, checks)
  }

  createSlackTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionSlackPendingTask<{occ: true}>>
  ): TaskEither<TaskCreateError, void> {
    return pipe(
      this.taskRepo.createSlackTask(context, request),
      bestEffort(
        (event: TaskReadyEvent) => this.publishCommittedTask(context, event),
        (error, event) => Logger.warn(`Task event delivery failed for ${event.eventId}`, String(error))
      ),
      TE.map(() => undefined)
    )
  }

  updateSlackTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionSlackTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ> {
    return this.taskRepo.updateSlackTask(context, task, checks)
  }

  getWebhookTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return this.taskRepo.getWebhookTask(context, taskId)
  }

  getEmailTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return this.taskRepo.getEmailTask(context, taskId)
  }

  getSlackTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>> {
    return this.taskRepo.getSlackTask(context, taskId)
  }

  /** Queue failure cannot undo committed tasks; their outbox facts remain available for recovery. */
  private publishCommittedTask(context: TenantContext, event: TaskReadyEvent) {
    return pipe(
      this.queue.enqueue(event),
      TE.chainW(() => this.tenantOutbox.markPublished(context, event.eventId))
    )
  }
}

type DispatchOperation = (
  claim: Extract<DispatchClaimResult, {state: "admitted"}>,
  assertLease: () => Promise<void>
) => Promise<void>
