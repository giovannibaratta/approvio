import {TenantOutboxService} from "../durable-work/tenant-outbox.service"
import {Inject, Injectable, Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {
  evaluateWorkflowStatus,
  WorkflowStatus,
  TenantContext,
  TenantEvent,
  TenantEventValidationError,
  Workflow,
  Versioned,
  WorkflowRecalculateEvent
} from "@domain"
import {bestEffort, generateDeterministicId} from "@utils"
import {VOTE_REPOSITORY_TOKEN, VoteRepository, FindVotesError} from "../vote/interfaces"
import {
  WORKFLOW_REPOSITORY_TOKEN,
  WORKFLOW_EXPIRATION_SCHEDULE_REPOSITORY_TOKEN,
  WorkflowExpirationScheduleRepository,
  WorkflowRepository,
  WorkflowGetError,
  WorkflowUpdateError
} from "./interfaces"
import {
  EVENT_RECEIPT_REPOSITORY_TOKEN,
  EventReceiptRepository,
  OUTBOX_REPOSITORY_TOKEN,
  OutboxRepository
} from "../durable-work/interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "../transaction/interfaces"
import {QueueService} from "../queue"
import {inTransaction} from "../transaction/in-transaction"

export type WorkflowRecalculationError =
  | WorkflowGetError
  | FindVotesError
  | WorkflowUpdateError
  | "unknown_error"
  | TenantEventValidationError
  | "event_not_found"
  | "event_mismatch"
  | "repository_dependency_error"

@Injectable()
export class WorkflowRecalculationService {
  constructor(
    private readonly tenantOutbox: TenantOutboxService,
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(WORKFLOW_EXPIRATION_SCHEDULE_REPOSITORY_TOKEN)
    private readonly expirationScheduleRepo: WorkflowExpirationScheduleRepository,
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
    @Inject(OUTBOX_REPOSITORY_TOKEN) private readonly outboxRepository: OutboxRepository,
    @Inject(EVENT_RECEIPT_REPOSITORY_TOKEN) private readonly eventReceipts: EventReceiptRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactionManager: TenantTransactionManager,
    private readonly queueService: QueueService
  ) {}

  /**
   * Recalculate the workflow from its votes and expiration date. Skip events already processed.
   * Reject requests that do not match the committed outbox event.
   * Save the new status and any status-change event together, then publish after commit.
   */
  recalculateWorkflowStatus(event: WorkflowRecalculateEvent): TaskEither<WorkflowRecalculationError, void> {
    return pipe(
      TE.right(event),
      inTransaction(this.transactionManager, event, received => this.verifyAndRecalculate(received)),
      // Queue delivery happens after commit; failures leave the durable outbox available for retry.
      TE.chainFirstW(events => this.deliverEvents(event, events)),
      TE.map(() => undefined)
    )
  }

  /**
   * Schedule recalculation for up to limit workflows that expired before sweptAt.
   * Return the number scheduled; their statuses change when recalculation runs.
   */
  scheduleExpiredWorkflowRecalculations(
    context: TenantContext,
    sweptAt: Date,
    limit: number
  ): TaskEither<WorkflowRecalculationError, number> {
    return pipe(
      TE.right(undefined),
      inTransaction(this.transactionManager, context, () => this.prepareExpirationBatch(context, sweptAt, limit)),
      // Queue delivery happens after commit; failures leave the durable outbox available for retry.
      TE.chainFirstW(({events}) => this.deliverEvents(context, events)),
      TE.map(({count}) => count)
    )
  }

  /**
   * Return the organization's schedule when its next sweep is due by dueBefore and its
   * previous scheduling time is absent or at most scheduledBefore.
   */
  getDueWorkflowExpirationSchedule(context: TenantContext, dueBefore: Date, scheduledBefore: Date) {
    return pipe(
      TE.right(undefined),
      inTransaction(this.transactionManager, context, () =>
        this.expirationScheduleRepo.getDueExpirationSchedule(context, dueBefore, scheduledBefore)
      )
    )
  }

  /**
   * Record scheduledAt if the schedule is due and eligible to be queued again.
   * Return false if it is missing, not yet due, or was scheduled after scheduledBefore.
   */
  markWorkflowExpirationSweepScheduled(context: TenantContext, scheduledAt: Date, scheduledBefore: Date) {
    return pipe(
      TE.right(undefined),
      inTransaction(this.transactionManager, context, () =>
        this.expirationScheduleRepo.claimExpirationSchedule(context, scheduledAt, scheduledBefore)
      )
    )
  }

  private recordAndRecalculate(
    event: WorkflowRecalculateEvent
  ): TaskEither<WorkflowRecalculationError, ReadonlyArray<TenantEvent>> {
    return pipe(
      this.eventReceipts.record(event, "recalculation", event.eventId),
      TE.chainW(result =>
        result === "duplicate" ? TE.right(undefined) : this.evaluateAndPersistStatus(event, event.workflowId)
      ),
      TE.map(event => (event ? [event] : []))
    )
  }

  private verifyAndRecalculate(event: WorkflowRecalculateEvent) {
    return pipe(
      this.outboxRepository.getEvent(event, event.eventId),
      TE.chainW(persisted =>
        persisted.type === "workflow.recalculate" &&
        persisted.schemaVersion === event.schemaVersion &&
        persisted.workflowId === event.workflowId
          ? this.recordAndRecalculate(persisted)
          : TE.left("event_mismatch" as const)
      )
    )
  }

  private prepareExpirationBatch(context: TenantContext, sweptAt: Date, limit: number) {
    return pipe(
      this.workflowRepo.findExpiredWorkflows(context, sweptAt, limit),
      TE.chainW(workflowIds => this.persistExpirationBatch(context, sweptAt, workflowIds)),
      TE.chainFirstW(() => this.expirationScheduleRepo.completeExpirationSchedule(context, sweptAt))
    )
  }

  private persistExpirationBatch(context: TenantContext, sweptAt: Date, workflowIds: ReadonlyArray<string>) {
    const events: ReadonlyArray<TenantEvent> = workflowIds.map(workflowId => ({
      schemaVersion: 1,
      eventId: generateDeterministicId(`recalculate-${workflowId}-${sweptAt.toISOString()}`),
      workflowId,
      organizationId: context.organizationId,
      type: "workflow.recalculate"
    }))

    return pipe(
      TE.sequenceArray(events.map(event => this.tenantOutbox.append(context, event))),
      TE.chainW(() =>
        workflowIds.length === 0
          ? TE.right(undefined)
          : this.workflowRepo.markWorkflowsAsRecalculationRequired(context, [...workflowIds])
      ),
      TE.map(() => ({count: workflowIds.length, events}))
    )
  }

  private deliverEvents(context: TenantContext, events: ReadonlyArray<TenantEvent>): TaskEither<never, void> {
    return pipe(
      events,
      TE.traverseArray(event => this.deliverEvent(context, event)),
      TE.map(() => undefined)
    )
  }

  private deliverEvent(context: TenantContext, event: TenantEvent) {
    return pipe(
      TE.right(event),
      bestEffort(
        (event: TenantEvent) => this.enqueueAndMarkPublished(context, event),
        (error, event) => Logger.warn(`Best-effort delivery failed for ${event.type} event ${event.eventId}`, error)
      )
    )
  }

  private enqueueAndMarkPublished(context: TenantContext, event: TenantEvent) {
    return pipe(
      this.queueService.enqueue(event),
      TE.chainW(() => this.tenantOutbox.markPublished(context, event.eventId))
    )
  }

  /** Returns the optional status event for publication after the transaction commits. */
  private evaluateAndPersistStatus(
    context: TenantContext,
    workflowId: string
  ): TaskEither<WorkflowRecalculationError, TenantEvent | undefined> {
    const getWorkflow = () =>
      this.workflowRepo.getWorkflowById(context, workflowId, {occ: true, workflowTemplate: true})
    const getVotes = () => this.voteRepo.getVotesByWorkflowId(context, workflowId)

    return pipe(
      TE.Do,
      TE.bindW("workflow", getWorkflow),
      TE.bindW("votes", getVotes),
      TE.bindW("workflowWithUpdatedStatus", ({workflow, votes}) =>
        TE.fromEither(evaluateWorkflowStatus(workflow, votes))
      ),
      TE.chainW(({workflow, workflowWithUpdatedStatus}) =>
        this.persistWorkflowStatus(context, workflow, workflowWithUpdatedStatus)
      )
    )
  }

  private persistWorkflowStatus(context: TenantContext, workflow: Versioned<Workflow>, updated: Workflow) {
    return pipe(
      TE.fromIO(() => Logger.log(`Workflow ${updated.id} new status: ${updated.status}`)),
      TE.chainW(() =>
        this.workflowRepo.updateWorkflowConcurrentSafe(context, updated.id, workflow.occ, {
          updatedAt: updated.updatedAt,
          status: updated.status,
          recalculationRequired: false
        })
      ),
      TE.chainFirstIOK(() => () => Logger.log(`Persisted status for Workflow ${workflow.id}`)),
      TE.chainW(() => this.appendStatusChange(context, workflow, updated))
    )
  }

  private appendStatusChange(
    context: TenantContext,
    workflow: Versioned<Workflow>,
    updated: Workflow
  ): TaskEither<WorkflowRecalculationError, TenantEvent | undefined> {
    if (workflow.status === updated.status || updated.status === WorkflowStatus.EVALUATION_IN_PROGRESS)
      return TE.right(undefined)

    const event: TenantEvent = {
      schemaVersion: 1,
      eventId: generateDeterministicId(`${workflow.id}-${updated.status}-${updated.updatedAt.toISOString()}`),
      workflowId: workflow.id,
      workflowOcc: workflow.occ,
      organizationId: context.organizationId,
      type: "workflow.status_changed",
      previousStatus: workflow.status,
      status: updated.status,
      actor: {type: "system", displayName: "Workflow recalculation"},
      occurredAt: updated.updatedAt
    }
    return pipe(
      this.tenantOutbox.append(context, event),
      TE.map(() => event)
    )
  }
}
