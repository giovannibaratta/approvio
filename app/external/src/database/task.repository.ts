import {Injectable, Logger} from "@nestjs/common"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionSlackPendingTask,
  DecoratedWorkflowActionSlackTask,
  DecoratedWorkflowActionWebhookPendingTask,
  DecoratedWorkflowActionWebhookTask,
  TaskStatus,
  TaskReadyEvent,
  TenantContext,
  WorkflowActionEmailTask,
  WorkflowActionEmailTaskFactory,
  WorkflowActionSlackTaskFactory,
  WorkflowActionTaskDecoratorSelector,
  WorkflowActionWebhookTaskFactory
} from "@domain"
import {TenantEncryptionService} from "@external/kms/context-bound-encryption.service"
import {Prisma} from "@prisma/client"
import {isPrismaForeignKeyConstraintError} from "./errors"
import {
  TaskCreateError,
  TaskCreateRequest,
  TaskGetErrorEmailTask,
  TaskGetErrorSlackTask,
  TaskGetErrorWebhookTask,
  TaskRepository,
  TaskGenerationRequest,
  TaskGenerationResult,
  TaskPersistenceMetadata,
  TaskUpdateChecks,
  TaskUpdateError
} from "@services/task/interfaces"
import {Occ} from "@domain"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkerDatabaseClient, WorkerTransaction} from "./capability-database-client"
import {v5 as uuidv5, v7 as uuidv7} from "uuid"
import {mapToJsonValue} from "./shared/json-mappers"

type TaskKind = "email" | "webhook" | "slack"
const TASK_READY_EVENT_NAMESPACE = "95650ca4-d361-11f0-8d0d-325096b39f47"
type TaskRow = {
  readonly id: string
  readonly organizationId: string
  readonly workflowId: string
  readonly state: string
  readonly encPayload: string
  readonly attempts: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly occ: bigint
  readonly fencing: bigint
  readonly leaseOwner: string | null
  readonly leaseUntil: Date | null
}

type TaskCreateFields = {
  readonly id: string
  readonly organizationId: string
  readonly workflowId: string
  readonly status: TaskStatus
  readonly occ: bigint
  readonly createdAt: Date
  readonly updatedAt: Date
}

type PreparedEventTask = {
  readonly task: TaskCreateFields
  readonly metadata: TaskPersistenceMetadata
  readonly kind: TaskKind
  readonly encPayload: string
}

@Injectable()
export class PrismaTaskRepository implements TaskRepository {
  constructor(
    private readonly workers: WorkerDatabaseClient,
    private readonly tenantEncryption: TenantEncryptionService
  ) {}

  createEventTasks(
    context: TenantContext,
    eventId: string,
    requests: ReadonlyArray<TaskGenerationRequest>
  ): TE.TaskEither<TaskCreateError, TaskGenerationResult> {
    return pipe(
      TE.sequenceArray(requests.map(request => this.prepareEventTask(context, request, eventId))),
      TE.chainW(tasks =>
        TE.tryCatch(
          () =>
            this.workers.transactional(context.organizationId, async cx => {
              const receipt = await cx.eventReceipts.record("task_generation", eventId)
              if (receipt === "duplicate") return {outcome: "duplicate" as const, events: []}

              const events: TaskReadyEvent[] = []
              for (const task of tasks) {
                const event = await this.persistEventTask(context, task, cx)
                if (event) events.push(event)
              }
              return {outcome: "new" as const, events}
            }),
          error => this.mapEventTaskCreateError(error)
        )
      )
    )
  }

  createEmailTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionEmailTask<{occ: true}>>
  ): TE.TaskEither<TaskCreateError, TaskReadyEvent> {
    const task = request.task
    return this.create(context, task, request.metadata, "email", {
      recipients: task.recipients,
      subject: task.subject,
      body: task.body
    })
  }

  createWebhookTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionWebhookPendingTask<{occ: true}>>
  ): TE.TaskEither<TaskCreateError, TaskReadyEvent> {
    const task = request.task
    return this.create(context, task, request.metadata, "webhook", {
      url: task.url,
      method: task.method,
      ...(task.headers === undefined ? {} : {headers: task.headers}),
      ...(task.payload === undefined ? {} : {payload: task.payload})
    })
  }

  createSlackTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionSlackPendingTask<{occ: true}>>
  ): TE.TaskEither<TaskCreateError, TaskReadyEvent> {
    const task = request.task
    return this.create(context, task, request.metadata, "slack", {
      webhookUrl: task.webhookUrl,
      ...(task.message === undefined ? {} : {message: task.message})
    })
  }

  updateEmailTask(
    context: TenantContext,
    task: WorkflowActionEmailTask,
    checks: TaskUpdateChecks
  ): TE.TaskEither<TaskUpdateError, Occ> {
    return this.update(context, task, checks, "email", {
      recipients: task.recipients,
      subject: task.subject,
      body: task.body
    })
  }

  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TE.TaskEither<TaskUpdateError, Occ> {
    return this.update(context, task, checks, "webhook", {
      url: task.url,
      method: task.method,
      ...(task.headers === undefined ? {} : {headers: task.headers}),
      ...(task.payload === undefined ? {} : {payload: task.payload})
    })
  }

  updateSlackTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionSlackTask<T>,
    checks: TaskUpdateChecks
  ): TE.TaskEither<TaskUpdateError, Occ> {
    return this.update(context, task, checks, "slack", {
      webhookUrl: task.webhookUrl,
      ...(task.message === undefined ? {} : {message: task.message})
    })
  }

  getEmailTask(
    context: TenantContext,
    taskId: string
  ): TE.TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return pipe(
      this.get(context, taskId, "email"),
      TE.chainW(row => this.decryptPayload(context, row, "email")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionEmailTaskFactory.validate<{occ: true}>({...toLegacyTask(row), ...payload})
      )
    )
  }

  getWebhookTask(
    context: TenantContext,
    taskId: string
  ): TE.TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return pipe(
      this.get(context, taskId, "webhook"),
      TE.chainW(row => this.decryptPayload(context, row, "webhook")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionWebhookTaskFactory.validate<{occ: true}>({...toLegacyTask(row), ...payload})
      )
    )
  }

  getSlackTask(
    context: TenantContext,
    taskId: string
  ): TE.TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>> {
    return pipe(
      this.get(context, taskId, "slack"),
      TE.chainW(row => this.decryptPayload(context, row, "slack")),
      TE.chainEitherKW(({row, payload}) =>
        WorkflowActionSlackTaskFactory.validate<{occ: true}>({...toLegacyTask(row), ...payload})
      )
    )
  }

  private create(
    context: TenantContext,
    task: TaskCreateFields,
    metadata: TaskCreateRequest<DecoratedWorkflowActionEmailTask<{occ: true}>>["metadata"],
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TE.TaskEither<TaskCreateError, TaskReadyEvent> {
    if (task.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      this.encryptPayload(context, task.id, kind, payload),
      TE.chainW(encPayload =>
        TE.tryCatch(
          () =>
            this.workers.transactional(context.organizationId, cx =>
              this.persistCreate(context, task, metadata, kind, encPayload, cx)
            ),
          error => this.mapCreateError(error)
        )
      )
    )
  }

  private prepareEventTask(
    context: TenantContext,
    request: TaskGenerationRequest,
    eventId: string
  ): TE.TaskEither<TaskCreateError, PreparedEventTask> {
    switch (request.kind) {
      case "email":
        return this.prepareEventTaskPayload(context, request, eventId, "email", {
          recipients: request.request.task.recipients,
          subject: request.request.task.subject,
          body: request.request.task.body
        })
      case "webhook":
        return this.prepareEventTaskPayload(context, request, eventId, "webhook", {
          url: request.request.task.url,
          method: request.request.task.method,
          ...(request.request.task.headers === undefined ? {} : {headers: request.request.task.headers}),
          ...(request.request.task.payload === undefined ? {} : {payload: request.request.task.payload})
        })
      case "slack":
        return this.prepareEventTaskPayload(context, request, eventId, "slack", {
          webhookUrl: request.request.task.webhookUrl,
          ...(request.request.task.message === undefined ? {} : {message: request.request.task.message})
        })
    }
  }

  private prepareEventTaskPayload(
    context: TenantContext,
    request: TaskGenerationRequest,
    eventId: string,
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TE.TaskEither<TaskCreateError, PreparedEventTask> {
    const {task, metadata} = request.request
    if (task.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    if (metadata.eventId !== eventId) return TE.left("event_mismatch")
    return pipe(
      this.encryptPayload(context, task.id, kind, payload),
      TE.map(encPayload => ({task, metadata, kind, encPayload}))
    )
  }

  private async persistEventTask(context: TenantContext, prepared: PreparedEventTask, cx: WorkerTransaction) {
    const {task, metadata, kind, encPayload} = prepared
    const existing = await cx.durableWork.findUnique({
      where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
      select: {kind: true}
    })
    if (existing) {
      if (existing.kind !== kind) throw new TaskEventMismatchError()
      const existingAction =
        kind === "email"
          ? await cx.workflowActionsEmailTask.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
              select: {eventId: true, actionIndex: true}
            })
          : kind === "webhook"
            ? await cx.workflowActionsWebhookTask.findUnique({
                where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
                select: {eventId: true, actionIndex: true}
              })
            : await cx.workflowActionsSlackTask.findUnique({
                where: {organizationId_id: {organizationId: context.organizationId, id: task.id}},
                select: {eventId: true, actionIndex: true}
              })
      if (existingAction?.eventId !== metadata.eventId || existingAction.actionIndex !== metadata.actionIndex)
        throw new TaskEventMismatchError()
      return
    }
    return this.persistCreate(context, task, metadata, kind, encPayload, cx)
  }

  private async persistCreate(
    context: TenantContext,
    task: TaskCreateFields,
    metadata: TaskPersistenceMetadata,
    kind: TaskKind,
    encPayload: string,
    cx: WorkerTransaction
  ): Promise<TaskReadyEvent> {
    const data = {
      id: task.id,
      organizationId: context.organizationId,
      workflowId: task.workflowId,
      eventId: metadata.eventId,
      actionIndex: metadata.actionIndex,
      encPayload,
      state: toDurableState(task.status),
      availableAt: metadata.availableAt,
      attempts: 0,
      fencing: 0n,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      occ: task.occ
    }
    await cx.durableWork.create({
      data: {
        id: task.id,
        organizationId: context.organizationId,
        kind,
        state: toDurableState(task.status),
        availableAt: metadata.availableAt,
        attempts: 0,
        fencing: 0n,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        occ: task.occ
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
    const readyEventId = uuidv5(`${metadata.eventId}:task.ready:${task.id}`, TASK_READY_EVENT_NAMESPACE)
    const readyEvent: TaskReadyEvent = {
      schemaVersion: 1,
      eventId: readyEventId,
      taskOcc: task.occ,
      organizationId: context.organizationId,
      type: "task.ready",
      taskId: task.id,
      taskKind: kind
    }
    await cx.tenantOutbox.create({
      data: {
        id: uuidv7(),
        organizationId: context.organizationId,
        eventId: readyEventId,
        eventType: "task.ready",
        schemaVersion: 1,
        resourceId: task.id,
        resourceVersion: task.occ,
        payload: mapToJsonValue(readyEvent),
        availableAt: metadata.availableAt,
        attempts: 0,
        createdAt: task.createdAt
      }
    })
    return readyEvent
  }

  private update(
    context: TenantContext,
    task: {
      readonly id: string
      readonly organizationId: string
      readonly status: TaskStatus
      readonly createdAt: Date
      readonly updatedAt: Date
    },
    checks: TaskUpdateChecks,
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TE.TaskEither<TaskUpdateError, Occ> {
    if (task.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return pipe(
      this.encryptPayload(context, task.id, kind, payload),
      TE.chainW(encPayload =>
        TE.tryCatch(
          async () => {
            const where = {
              organizationId: context.organizationId,
              id: task.id,
              occ: checks.occ,
              fencing: checks.fencing,
              leaseOwner: checks.leaseOwner
            }
            const data = {
              encPayload,
              state: toDurableState(task.status),
              updatedAt: task.updatedAt,
              occ: {increment: 1}
            }
            const result = await this.workers.transactional(context.organizationId, cx =>
              kind === "email"
                ? cx.workflowActionsEmailTask.updateMany({where, data})
                : kind === "webhook"
                  ? cx.workflowActionsWebhookTask.updateMany({where, data})
                  : cx.workflowActionsSlackTask.updateMany({where, data})
            )
            if (result.count !== 1) throw new LeaseLostError()
            return {occ: checks.occ + 1n}
          },
          error => this.mapUpdateError(error)
        )
      )
    )
  }

  private get(
    context: TenantContext,
    taskId: string,
    kind: TaskKind
  ): TE.TaskEither<"task_not_found" | "unknown_error", TaskRow> {
    return pipe(
      TE.tryCatch(
        async () => {
          const where = {organizationId_id: {organizationId: context.organizationId, id: taskId}}
          const row = await this.workers.transactional(context.organizationId, cx =>
            kind === "email"
              ? cx.workflowActionsEmailTask.findUnique({where})
              : kind === "webhook"
                ? cx.workflowActionsWebhookTask.findUnique({where})
                : cx.workflowActionsSlackTask.findUnique({where})
          )
          if (!row) throw new TaskNotFoundError()
          return row
        },
        error => this.mapGetError(error)
      )
    )
  }

  private encryptPayload(
    context: TenantContext,
    taskId: string,
    kind: TaskKind,
    payload: Record<string, unknown>
  ): TE.TaskEither<"encryption_failed", string> {
    return pipe(
      TE.fromEither(
        E.tryCatch(
          () => JSON.stringify(payload),
          () => "encryption_failed" as const
        )
      ),
      TE.chainW(plaintext => this.tenantEncryption.encrypt(encryptionContext(context, taskId, kind), plaintext)),
      TE.mapLeft(() => "encryption_failed" as const)
    )
  }

  private decryptPayload(
    context: TenantContext,
    row: TaskRow,
    kind: TaskKind
  ): TE.TaskEither<"decryption_failed", {readonly row: TaskRow; readonly payload: Record<string, unknown>}> {
    return pipe(
      this.tenantEncryption.decrypt(encryptionContext(context, row.id, kind), row.encPayload),
      TE.mapLeft(() => "decryption_failed" as const),
      TE.chainEitherKW(plaintext => {
        const parsed = E.tryCatch(
          () => JSON.parse(plaintext) as unknown,
          () => "decryption_failed" as const
        )
        if (E.isLeft(parsed) || !isRecord(parsed.right)) return E.left("decryption_failed" as const)
        return E.right({row, payload: parsed.right})
      })
    )
  }

  private mapCreateError(error: unknown): TaskCreateError {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "task_already_exists"
    Logger.error("Task create failed", error instanceof Error ? `${error.name}: ${error.message}` : "non_error")
    return "unknown_error"
  }

  private mapEventTaskCreateError(error: unknown): TaskCreateError {
    if (isPrismaForeignKeyConstraintError(error, "fk_tenant_event_receipts_outbox")) return "event_mismatch"
    if (error instanceof TaskEventMismatchError) return "event_mismatch"
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "task_already_exists"
    Logger.error("Event task creation failed", error instanceof Error ? error.name : "non_error")
    return "repository_dependency_error"
  }

  private mapUpdateError(error: unknown): TaskUpdateError {
    if (error instanceof LeaseLostError) return "lease_lost"
    Logger.error("Task update failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapGetError(error: unknown): "task_not_found" | "unknown_error" {
    if (error instanceof TaskNotFoundError) return "task_not_found"
    Logger.error("Task get failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

function encryptionContext(context: TenantContext, taskId: string, kind: TaskKind) {
  return {
    organizationId: context.organizationId,
    resourceType:
      kind === "email"
        ? ("email_task" as const)
        : kind === "webhook"
          ? ("webhook_task" as const)
          : ("slack_task" as const),
    resourceId: taskId,
    field: "payload" as const,
    formatVersion: 1 as const
  }
}

function toDurableState(status: TaskStatus): "ready" | "succeeded" | "failed" {
  if (status === TaskStatus.PENDING) return "ready"
  if (status === TaskStatus.COMPLETED) return "succeeded"
  return "failed"
}

function toLegacyTask(row: TaskRow) {
  const status =
    row.state === "succeeded" ? TaskStatus.COMPLETED : row.state === "failed" ? TaskStatus.ERROR : TaskStatus.PENDING
  return {
    id: row.id,
    organizationId: row.organizationId,
    workflowId: row.workflowId,
    status,
    retryCount: status === TaskStatus.PENDING ? 0 : row.attempts,
    ...(status === TaskStatus.ERROR ? {errorReason: "dispatch failed"} : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    occ: row.occ
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class LeaseLostError extends Error {}
class TaskEventMismatchError extends Error {}
class TaskNotFoundError extends Error {}
