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
  }
}
