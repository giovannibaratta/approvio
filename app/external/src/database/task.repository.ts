import {Injectable, Logger} from "@nestjs/common"
import {
  TaskRepository,
  TaskCreateError,
  TaskGetErrorWebhookTask,
  TaskGetErrorEmailTask,
  TaskGetErrorSlackTask,
  TaskGenerationRequest,
  TaskPersistenceMetadata,
  TaskLoadStorageError,
  TaskLoadFailure
} from "@services/task/interfaces"
import {
  WorkflowActionWebhookTaskFactory,
  WorkflowActionSlackTaskFactory,
  TaskReadyEvent,
  TenantContext,
  TaskCreation
} from "@domain"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  DecoratedWorkflowActionSlackTask,
  WorkflowActionEmailTaskFactory
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {
  Prisma,
  WorkflowActionsWebhookTask as PrismaWorkflowActionsWebhookTask,
  WorkflowActionsSlackTask as PrismaWorkflowActionsSlackTask
} from "@prisma/client"
import {mapToJsonValue} from "./shared/json-mappers"
import {pipe} from "fp-ts/function"
import {CryptoError} from "@services/encryption/interfaces"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {fromPromise, fromEitherPromise, isRetryableTransactionError} from "./repository-operation"
import {WorkerDatabaseClient, WorkerTransaction} from "./capability-database-client"
import {chainNullableToLeft} from "./utils"
import {isPrismaUniqueConstraintError, isTemporaryDatabaseError} from "./errors"
import {TransactionRetryExhaustedError} from "./database-client"

type TaskKind = "email" | "webhook" | "slack"
type TaskRow =
  Prisma.WorkflowActionsEmailTaskGetPayload<object> | PrismaWorkflowActionsWebhookTask | PrismaWorkflowActionsSlackTask

type TaskCreateFields = {
  readonly id: string
  readonly workflowId: string
}

type PreparedEventTask = {
  readonly task: TaskCreateFields
  readonly metadata: TaskPersistenceMetadata
  readonly kind: TaskKind
  readonly encPayload: string
  readonly creation: TaskCreation
}

@Injectable()
export class PrismaTaskRepository implements TaskRepository {
  constructor(
    private readonly workers: WorkerDatabaseClient,
    private readonly tenantEncryption: TenantEncryptionService
  ) {}

  getSlackTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>> {
    return pipe(
      this.getSlackTaskTE(context, taskId),
      TE.chainW(row => this.decryptPayload(context, row, "slack")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionSlackTaskFactory.validate<{occ: true}>({...mapToTaskValidationInput(row), ...payload})
      ),
      TE.mapLeft(code => this.toTaskLoadFailure(code))
    )
  }

  getWebhookTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return pipe(
      this.getWebhookTaskTE(context, taskId),
      TE.chainW(row => this.decryptPayload(context, row, "webhook")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionWebhookTaskFactory.validate<{occ: true}>({...mapToTaskValidationInput(row), ...payload})
      ),
      TE.mapLeft(code => this.toTaskLoadFailure(code))
    )
  }

  getEmailTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return pipe(
      this.getEmailTaskTE(context, taskId),
      TE.chainW(row => this.decryptPayload(context, row, "email")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionEmailTaskFactory.validate<{occ: true}>({...mapToTaskValidationInput(row), ...payload})
      ),
      TE.mapLeft(code => this.toTaskLoadFailure(code))
    )
  }

  private getWebhookTaskTE(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorWebhookTask["code"], PrismaWorkflowActionsWebhookTask> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.workflowActionsWebhookTask.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
            })
          ),
        error => this.mapTaskLoadError(error, "webhook", taskId)
      ),
      chainNullableToLeft("task_not_found" as const)
    )
  }

  private getEmailTaskTE(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorEmailTask["code"], Prisma.WorkflowActionsEmailTaskGetPayload<object>> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.workflowActionsEmailTask.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
            })
          ),
        error => this.mapTaskLoadError(error, "email", taskId)
      ),
      chainNullableToLeft("task_not_found" as const)
    )
  }

  private getSlackTaskTE(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorSlackTask["code"], PrismaWorkflowActionsSlackTask> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.workflowActionsSlackTask.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: taskId}}
            })
          ),
        error => this.mapTaskLoadError(error, "slack", taskId)
      ),
      chainNullableToLeft("task_not_found" as const)
    )
  }

  createEventTask(
    context: TenantContext,
    request: TaskGenerationRequest,
    creation: TaskCreation
  ): TaskEither<TaskCreateError, TaskReadyEvent | undefined> {
    return pipe(
      this.prepareEventTask(context, request, creation),
      TE.chainW(task =>
        fromEitherPromise(
          () => this.workers.transactional(context.organizationId, cx => this.persistEventTask(context, task, cx)),
          error => this.mapEventTaskCreateError(error)
        )
      )
    )
  }

  private prepareEventTask(
    context: TenantContext,
    request: TaskGenerationRequest,
    creation: TaskCreation
  ): TaskEither<TaskCreateError, PreparedEventTask> {
    switch (request.kind) {
      case "email":
        return this.prepareEventTaskPayload(context, request, creation, "email", {
          recipients: request.request.task.recipients,
          subject: request.request.task.subject,
          body: request.request.task.body
        })
      case "webhook":
        return this.prepareEventTaskPayload(context, request, creation, "webhook", {
          url: request.request.task.url,
          method: request.request.task.method,
          ...(request.request.task.headers === undefined ? {} : {headers: request.request.task.headers}),
          ...(request.request.task.payload === undefined ? {} : {payload: request.request.task.payload})
        })
      case "slack":
        return this.prepareEventTaskPayload(context, request, creation, "slack", {
          webhookUrl: request.request.task.webhookUrl,
          ...(request.request.task.message === undefined ? {} : {message: request.request.task.message})
        })
    }
  }

  private prepareEventTaskPayload(
    context: TenantContext,
    request: TaskGenerationRequest,
    creation: TaskCreation,
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TaskEither<TaskCreateError, PreparedEventTask> {
    const {task, metadata} = request.request
    return pipe(
      this.encryptPayload(context, task.id, kind, payload),
      TE.map(encPayload => ({task, metadata, kind, encPayload, creation}))
    )
  }

  private async persistEventTask(context: TenantContext, prepared: PreparedEventTask, cx: WorkerTransaction) {
    const {task, metadata, kind, encPayload, creation} = prepared
    const existing = await cx.durableWork.findUnique({
      where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
      select: {kind: true}
    })
    if (existing) {
      if (existing.kind !== kind) return E.left("event_mismatch" as const)
      let existingAction: Pick<TaskRow, "eventId" | "actionIndex"> | null
      switch (kind) {
        case "email":
          existingAction = await cx.workflowActionsEmailTask.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
            select: {eventId: true, actionIndex: true}
          })
          break
        case "webhook":
          existingAction = await cx.workflowActionsWebhookTask.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
            select: {eventId: true, actionIndex: true}
          })
          break
        case "slack":
          existingAction = await cx.workflowActionsSlackTask.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
            select: {eventId: true, actionIndex: true}
          })
          break
      }
      if (existingAction?.eventId !== metadata.eventId || existingAction.actionIndex !== metadata.actionIndex)
        return E.left("event_mismatch" as const)
      return E.right(undefined)
    }
    return E.right(await this.persistCreate(context, task, metadata, kind, encPayload, creation, cx))
  }

  private async persistCreate(
    context: TenantContext,
    task: TaskCreateFields,
    metadata: TaskPersistenceMetadata,
    kind: TaskKind,
    encPayload: string,
    creation: TaskCreation,
    cx: WorkerTransaction
  ): Promise<TaskReadyEvent> {
    const {work, outbox} = creation
    const readyEvent = outbox.event
    const data = {
      id: work.id,
      organizationId: context.organizationId,
      workflowId: task.workflowId,
      eventId: metadata.eventId,
      actionIndex: metadata.actionIndex,
      encPayload,
      state: work.state,
      availableAt: work.availableAt,
      attempts: work.attempts,
      fencing: work.fencing,
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
      occ: work.occ
    }
    await cx.durableWork.create({
      data: {
        ...work,
        organizationId: context.organizationId
      }
    })
    switch (kind) {
      case "email":
        await cx.workflowActionsEmailTask.create({data})
        break
      case "webhook":
        await cx.workflowActionsWebhookTask.create({data})
        break
      case "slack":
        await cx.workflowActionsSlackTask.create({data})
        break
    }
    await cx.tenantOutbox.create({
      data: {
        id: outbox.id,
        organizationId: context.organizationId,
        eventId: readyEvent.eventId,
        eventType: readyEvent.type,
        schemaVersion: readyEvent.schemaVersion,
        resourceId: readyEvent.taskId,
        resourceVersion: readyEvent.taskOcc,
        payload: mapToJsonValue(readyEvent),
        availableAt: outbox.availableAt,
        attempts: outbox.attempts,
        occ: outbox.occ,
        createdAt: outbox.createdAt
      }
    })
    return readyEvent
  }

  private encryptPayload(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TaskEither<CryptoError, string> {
    return pipe(
      TE.fromEither(
        E.tryCatch(
          () => JSON.stringify(payload),
          () => "encryption_failed" as const
        )
      ),
      TE.chainW(plaintext => this.tenantEncryption.encrypt(encryptionContext(context, taskId, kind), plaintext))
    )
  }

  private decryptPayload(
    context: TenantContext,
    row: TaskRow,
    kind: TaskKind
  ): TaskEither<
    CryptoError | "task_payload_invalid",
    {readonly row: TaskRow; readonly payload: Record<string, unknown>}
  > {
    return pipe(
      this.tenantEncryption.decrypt(encryptionContext(context, row.id, kind), row.encPayload),
      TE.chainEitherKW(plaintext => {
        const parsed = E.tryCatch(
          () => JSON.parse(plaintext) as unknown,
          () => "task_payload_invalid" as const
        )
        if (E.isLeft(parsed) || !isRecord(parsed.right)) return E.left("task_payload_invalid" as const)
        return E.right({row, payload: parsed.right})
      })
    )
  }

  private toTaskLoadFailure<Code extends string>(code: Code): TaskLoadFailure<Code> {
    // Current task decryption uses local environment keys. Invalid ciphertext,
    // context, payloads and domain validation cannot recover through another attempt.
    return {
      code,
      retryable: code === "task_load_transaction_conflict" || code === "task_load_temporarily_unavailable"
    }
  }

  private mapTaskLoadError(error: unknown, kind: TaskKind, taskId: string): TaskLoadStorageError {
    // fromPromise preserves the original conflict for whole-transaction retry.
    if (isRetryableTransactionError(error)) return "task_load_transaction_conflict"
    Logger.error(`Failed to get ${kind} task ${taskId}`, error)
    // A standalone read may already have exhausted the database retry budget.
    // Preserve its conflict classification so bounded queue retries remain possible.
    if (error instanceof TransactionRetryExhaustedError && isRetryableTransactionError(error.cause))
      return "task_load_transaction_conflict"
    return isTemporaryDatabaseError(error) ? "task_load_temporarily_unavailable" : "task_load_storage_error"
  }

  private mapEventTaskCreateError(error: unknown): TaskCreateError {
    let table: string | undefined
    if (error instanceof Prisma.PrismaClientKnownRequestError)
      switch (error.meta?.modelName) {
        case Prisma.ModelName.DurableWork:
          table = "durable_work"
          break
        case Prisma.ModelName.WorkflowActionsEmailTask:
          table = "workflow_actions_email_task"
          break
        case Prisma.ModelName.WorkflowActionsWebhookTask:
          table = "workflow_actions_webhook_tasks"
          break
        case Prisma.ModelName.WorkflowActionsSlackTask:
          table = "workflow_actions_slack_tasks"
          break
      }

    if (
      table !== undefined &&
      (isPrismaUniqueConstraintError(error, ["id"], `${table}_pkey`) ||
        isPrismaUniqueConstraintError(error, ["organization_id", "id"], `${table}_organization_id_unique`) ||
        (table !== "durable_work" &&
          isPrismaUniqueConstraintError(
            error,
            ["organization_id", "event_id", "action_index"],
            `${table}_organization_event_action_unique`
          )))
    )
      return "task_already_exists"
    Logger.error("Event task creation failed", error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }
}

const TASK_ENCRYPTION_RESOURCE_TYPES: Record<TaskKind, `${TaskKind}_task`> = {
  email: "email_task",
  webhook: "webhook_task",
  slack: "slack_task"
}

function encryptionContext(context: TenantContext, taskId: string, kind: TaskKind) {
  return {
    organizationId: context.organizationId,
    resourceType: TASK_ENCRYPTION_RESOURCE_TYPES[kind],
    resourceId: taskId,
    field: "payload" as const,
    formatVersion: 1 as const
  }
}

function mapToTaskValidationInput(row: TaskRow) {
  // Task rows hold snapshots; the live dispatch lifecycle is stored in durableWork.
  return {
    id: row.id,
    organizationId: row.organizationId,
    workflowId: row.workflowId,
    status: row.state,
    retryCount: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    occ: row.occ
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
