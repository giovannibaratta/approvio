import {DispatchService} from "../durable-work/dispatch.service"
import {TenantOutboxService} from "../durable-work/tenant-outbox.service"
import {WORKER_TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, ExecutionError} from "../transaction/interfaces"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {
  TASK_REPOSITORY_TOKEN,
  TaskCreateError,
  TaskGetErrorWebhookTask,
  TaskGetErrorEmailTask,
  TaskGetErrorSlackTask,
  TaskRepository,
  TaskGenerationRequest
} from "./interfaces"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  DecoratedWorkflowActionSlackTask,
  TenantContext,
  TaskReadyEvent,
  TaskCreationFactory
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as T from "fp-ts/Task"
import {pipe} from "fp-ts/function"
import {v7 as uuidv7} from "uuid"
import {QueueService} from "../queue"
import {DeliveryPermit, Lease, TaskKind} from "@domain"
import {
  DELIVERY_CONCURRENCY_LIMITER_TOKEN,
  DeliveryConcurrencyLimiter,
  WorkError,
  DispatchClaimResult,
  DispatchClaimResultFactory,
  EVENT_RECEIPT_REPOSITORY_TOKEN,
  EventReceiptRepository
} from "../durable-work/interfaces"

import {ORGANIZATION_STATUS_REPOSITORY_TOKEN, OrganizationStatusRepository} from "../tenancy/interfaces"

/**
 * Coordinates email, Slack and webhook workers; DispatchService persists guarded transitions.
 * Task states (each claim creates an admitted attempt):
 *
 *   ready / retry_due --> claimed --> executing --> succeeded / failed / unknown
 *          |                |             |
 *          |                |             +-- expired lease --> unknown
 *          |                +-- expired lease or pre-send failure --> retry_due
 *          +-- inactive org --> paused
 *
 * Unknown webhooks can be claimed again using taskId as the Idempotency-Key.
 * Unknown email/Slack delivery stays unknown to avoid duplicate sends.
 * Organization status is checked at admission; admitted work may finish after suspension/deletion begins.
 * retry_due leaves the task pending.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly tenantOutbox: TenantOutboxService,
    @Inject(TASK_REPOSITORY_TOKEN)
    private readonly taskRepo: TaskRepository,
    private readonly taskDispatch: DispatchService,
    private readonly queue: QueueService,
    @Inject(WORKER_TRANSACTION_MANAGER_TOKEN) private readonly workerTransactions: TenantTransactionManager,
    @Inject(ORGANIZATION_STATUS_REPOSITORY_TOKEN) private readonly organizationStatus: OrganizationStatusRepository,
    @Inject(DELIVERY_CONCURRENCY_LIMITER_TOKEN) private readonly deliveryConcurrency: DeliveryConcurrencyLimiter,
    @Inject(EVENT_RECEIPT_REPOSITORY_TOKEN) private readonly eventReceipts: EventReceiptRepository
  ) {}

  /**
   * Holds a delivery concurrency permit through task loading, egress and durable outcome recording.
   * Left preserves service and delivery errors; Bull processors handle job failure.
   */
  withDeliveryPermit<E>(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    operation: DispatchOperation<E>
  ): TaskEither<WorkError | E, void> {
    // Cache identifies each execution by a fresh UUID so concurrent jobs on the
    // same worker cannot release one another's slots. owner identifies the DB worker lease.
    // Cache operations stay outside database transactions and their retry loops.
    return TE.bracket(
      this.deliveryConcurrency.acquirePermit(context, taskId, uuidv7()),
      permit => this.runDispatch(context, taskId, kind, owner, permit, operation),
      permit => this.releaseDeliveryPermit(context, taskId, permit)
    )
  }

  private runDispatch<E>(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string,
    permit: DeliveryPermit,
    operation: DispatchOperation<E>
  ): TaskEither<WorkError | E, void> {
    return pipe(
      this.claimDispatch(context, taskId, kind, owner),
      TE.chainW(claim =>
        claim.state === "admitted"
          ? operation(claim, this.validateDispatchOwnership(context, taskId, permit, claim))
          : TE.right(undefined)
      )
    )
  }

  private validateDispatchOwnership(
    context: TenantContext,
    taskId: string,
    permit: DeliveryPermit,
    claim: Extract<DispatchClaimResult, {state: "admitted"}>
  ): TaskEither<WorkError, void> {
    return () =>
      pipe(
        this.deliveryConcurrency.validatePermit(context, taskId, permit),
        TE.chain(() => this.taskDispatch.validateAttemptLease(context, claim.attemptId, claim.lease))
      )()
  }

  private releaseDeliveryPermit(
    context: TenantContext,
    taskId: string,
    permit: DeliveryPermit
  ): TaskEither<never, void> {
    // Cleanup failure is logged without replacing the delivery result; the lease expires naturally.
    return pipe(
      this.deliveryConcurrency.releasePermit(context, taskId, permit),
      TE.orElse(error => {
        Logger.warn(`Delivery permit release failed for ${taskId}: ${error}`)
        return TE.right<never, void>(undefined)
      })
    )
  }

  claimDispatch(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    owner: string
  ): TaskEither<WorkError, DispatchClaimResult> {
    // Match DispatchService.claim's Read Committed isolation: cache provides
    // atomic delivery-permit acquisition, and concurrent database-count overshoot is accepted.
    // An outer Serializable transaction would retain the overhead of a strict concurrency limit.
    return this.workerTransactions.execute(
      context,
      () => {
        const now = new Date()
        return pipe(
          this.taskDispatch.recoverExpired(context, taskId, kind, now),
          TE.matchEW(
            error => this.handleDispatchRecoveryError(context, taskId, kind, owner, now, error),
            work =>
              work.state === "succeeded"
                ? TE.fromEither(DispatchClaimResultFactory.validate({state: "completed"}))
                : this.admitDispatch(context, taskId, kind, owner, now, work.state === "unknown")
          )
        )
      },
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
            this.taskDispatch.claim(context, taskId, kind, owner, evaluateAt),
            TE.chainEitherKW(claim => DispatchClaimResultFactory.validate({state: "admitted", ...claim}))
          )
        return pipe(
          this.taskDispatch.parkReady(context, taskId, kind),
          // The desired admission disposition is already satisfied; no pause was performed.
          TE.orElseW(error => (error === "dispatch_work_already_paused" ? TE.right(undefined) : TE.left(error))),
          TE.chainEitherKW(() => DispatchClaimResultFactory.validate({state: "parked"}))
        )
      })
    )
  }

  startDispatchExecution(context: TenantContext, attemptId: string, lease: Lease): TaskEither<WorkError, void> {
    return this.taskDispatch.startExecution(context, attemptId, lease)
  }

  /**
   * Records the generation receipt and tasks in one transaction; duplicate events
   * skip task preparation. Publishes task-ready events after the transaction succeeds.
   */
  createEventTasks(
    context: TenantContext,
    eventId: string,
    requests: ReadonlyArray<TaskGenerationRequest>
  ): TaskEither<TaskCreateError | ExecutionError | "event_not_found", "new" | "duplicate"> {
    if (requests.some(({request}) => request.task.organizationId !== context.organizationId))
      return TE.left("organization_mismatch")
    return pipe(
      this.workerTransactions.execute(context, () =>
        pipe(
          this.eventReceipts.record(context, "task_generation", eventId),
          TE.bindTo("outcome"),
          TE.bindW("events", ({outcome}) =>
            outcome === "duplicate"
              ? TE.right<never, ReadonlyArray<TaskReadyEvent>>([])
              : pipe(
                  TE.traverseSeqArray((request: TaskGenerationRequest) =>
                    request.request.metadata.eventId !== eventId
                      ? TE.left("event_mismatch" as const)
                      : this.taskRepo.createEventTask(
                          context,
                          request,
                          TaskCreationFactory.create(
                            request.request.task,
                            request.kind,
                            request.request.metadata.eventId,
                            request.request.metadata.availableAt
                          )
                        )
                  )(requests),
                  TE.map(events => events.filter(event => event !== undefined))
                )
          )
        )
      ),
      TE.orElseFirstIOK(
        error => () =>
          Logger.error(
            `Failed to create tasks for event ${eventId} in organization ${context.organizationId}`,
            String(error)
          )
      ),
      TE.chainFirstIOK(({outcome}) => () => {
        if (outcome === "duplicate")
          Logger.warn(
            `Tasks for event ${eventId} in organization ${context.organizationId} already processed; skipping.`
          )
      }),
      TE.chainFirstTaskK(({events}) =>
        T.traverseArray((event: TaskReadyEvent) =>
          pipe(
            this.publishCommittedTask(context, event),
            TE.orElseFirstIOK(
              error => () =>
                Logger.error(
                  `Failed to publish task-ready event ${event.eventId} for task ${event.taskId} in organization ${context.organizationId}; the outbox will retry.`,
                  String(error)
                )
            )
          )
        )(events)
      ),
      TE.map(({outcome}) => outcome)
    )
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

/**
 * Email, Slack and webhook processors supply their own load/send/completion logic.
 * The callback keeps provider details out of permit management and checks permit and attempt ownership before egress.
 */
type DispatchOperation<E> = (
  claim: Extract<DispatchClaimResult, {state: "admitted"}>,
  validateOwnership: TaskEither<WorkError, void>
) => TaskEither<WorkError | E, void>
