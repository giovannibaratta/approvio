import {Injectable, Logger} from "@nestjs/common"
import {
  TaskRepository,
  TaskCreateError,
  TaskUpdateError,
  TaskLockError,
  TaskUpdateChecks,
  TaskReference,
  TaskGetErrorWebhookTask,
  TaskGetErrorEmailTask
} from "@services/task/interfaces"
import {
  Occ,
  WorkflowActionTaskDecoratorSelector,
  WorkflowActionWebhookTaskFactory,
  DecoratedWorkflowActionWebhookPendingTask,
  TaskStatus,
  Lock
} from "@domain"
import {WorkflowActionType} from "@domain"
import {
  DecoratedWorkflowActionEmailTask,
  WorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionEmailTaskFactory
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {DatabaseClient} from "../database/database-client"
import {Prisma, WorkflowActionsWebhookTask as PrismaWorkflowActionsWebhookTask} from "@prisma/client"
import {ConcurrentUpdateError} from "./shared"
import {TaskLockedByOtherError, TaskNotFoundError, TaskUnknownError} from "./task.exceptions"
import {mapToNullableJsonValue} from "./shared/json-mappers"
import {pipe} from "fp-ts/lib/function"

@Injectable()
export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly prisma: DatabaseClient) {}

  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void> {
    return TE.tryCatch(
      async () => {
        await this.prisma.workflowActionsEmailTask.create({
          data: {
            id: task.id,
            workflowId: task.workflowId,
            status: task.status,
            retryCount: task.retryCount,
            recipients: task.recipients,
            subject: task.subject,
            body: task.body,
            errorReason: task.status === TaskStatus.ERROR ? task.errorReason : undefined,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            occ: task.occ
          }
        })
      },
      error => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return "task_already_exists" as const
        }
        Logger.error(`Failed to create email task ${task.id}`, error)
        return "unknown_error" as const
      }
    )
  }

  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, Occ> {
    return TE.tryCatch(
      async () => {
        const updatedTasks = await this.prisma.workflowActionsEmailTask.updateManyAndReturn({
          where: {
            id: task.id,
            occ: checks.occ,
            lockedBy: checks.lockOwner
          },
          data: {
            status: task.status,
            retryCount: task.retryCount,
            errorReason: task.status === TaskStatus.ERROR ? task.errorReason : undefined,
            updatedAt: task.updatedAt,
            occ: {increment: 1}
          }
        })

        if (updatedTasks.length === 0 || updatedTasks[0] === undefined)
          return await this.categorizeErrorTypeAndRaise("WorkflowActionsEmailTask", task.id, checks)

        return {occ: updatedTasks[0].occ}
      },
      error => {
        if (error instanceof ConcurrentUpdateError) return "task_concurrent_update" as const
        if (error instanceof TaskNotFoundError) return "task_concurrent_update" as const
        if (error instanceof TaskLockedByOtherError) return "task_locked_by_other" as const
        Logger.error(`Failed to update email task ${task.id}`, error)
        return "unknown_error" as const
      }
    )
  }

  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void> {
    return TE.tryCatch(
      async () => {
        await this.prisma.workflowActionsWebhookTask.create({
          data: {
            id: task.id,
            workflowId: task.workflowId,
            status: task.status,
            url: task.url,
            method: task.method,
            headers: mapHeadersToJsonValue(task.headers),
            payload: mapToNullableJsonValue(task.payload),
            responseStatus: undefined,
            responseBody: undefined,
            responseBodyStatus: undefined,
            retryCount: task.retryCount,
            errorReason: undefined,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            occ: task.occ
          }
        })
      },
      error => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return "task_already_exists" as const
        }
        Logger.error(`Failed to create webhook task ${task.id}`, error)
        return "unknown_error" as const
      }
    )
  }

  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ> {
    return TE.tryCatch(
      async () => {
        const {responseStatus, responseBody, responseBodyStatus} = extractResponseAttributes(task)

        const updatedTasks = await this.prisma.workflowActionsWebhookTask.updateManyAndReturn({
          where: {
            id: task.id,
            occ: checks.occ,
            lockedBy: checks.lockOwner
          },
          data: {
            status: task.status,
            retryCount: task.retryCount,
            errorReason: task.status === TaskStatus.ERROR ? task.errorReason : undefined,
            responseStatus,
            responseBody,
            responseBodyStatus,
            updatedAt: task.updatedAt,
            occ: {increment: 1}
          }
        })

        if (updatedTasks.length === 0 || updatedTasks[0] === undefined)
          return await this.categorizeErrorTypeAndRaise("WorkflowActionsWebhookTask", task.id, checks)

        return {occ: updatedTasks[0].occ}
      },
      error => {
        if (error instanceof ConcurrentUpdateError) return "task_concurrent_update" as const
        if (error instanceof TaskNotFoundError) return "task_concurrent_update" as const
        if (error instanceof TaskLockedByOtherError) return "task_locked_by_other" as const
        Logger.error(`Failed to update webhook task ${task.id}`, error)
        return "unknown_error" as const
      }
    )
  }

  getWebhookTask(taskId: string): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>> {
    return pipe(
      this.getWebhookTaskTE(taskId),
      TE.chainW(rawData => {
        const {lockedBy, lockedAt, headers, ...rest} = rawData

        if (lockedBy !== null && lockedAt === null) return TE.left("task_lock_inconsistent" as const)
        if (lockedBy === null && lockedAt !== null) return TE.left("task_lock_inconsistent" as const)

        let lock: Lock | undefined = undefined

        if (lockedBy !== null && lockedAt !== null)
          lock = {
            lockedBy,
            lockedAt
          }

        return TE.right({
          ...rest,
          headers: mapHeadersToRecord(headers),
          lock
        })
      }),
      TE.chainW(mappedTask => TE.fromEither(WorkflowActionWebhookTaskFactory.validate<{occ: true}>(mappedTask)))
    )
  }

  getEmailTask(taskId: string): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>> {
    return pipe(
      this.getEmailTaskTE(taskId),
      TE.chainW(rawData => {
        const {lockedBy, lockedAt, ...rest} = rawData

        if (lockedBy !== null && lockedAt === null) return TE.left("task_lock_inconsistent" as const)
        if (lockedBy === null && lockedAt !== null) return TE.left("task_lock_inconsistent" as const)

        let lock: Lock | undefined = undefined

        if (lockedBy !== null && lockedAt !== null)
          lock = {
            lockedBy,
            lockedAt
          }

        return TE.right({
          ...rest,
          lock
        })
      }),
      TE.chainW(mappedTask => TE.fromEither(WorkflowActionEmailTaskFactory.validate<{occ: true}>(mappedTask)))
    )
  }

  private getWebhookTaskTE(taskId: string): TaskEither<TaskGetErrorWebhookTask, PrismaWorkflowActionsWebhookTask> {
    return TE.tryCatch(
      async () => {
        const task = await this.prisma.workflowActionsWebhookTask.findUnique({
          where: {id: taskId}
        })
        if (!task) throw new TaskNotFoundError()
        return task
      },
      error => {
        if (error instanceof TaskNotFoundError) {
          Logger.warn(`Task ${taskId} not found`)
          return "task_not_found" as const
        }

        Logger.error(`Failed to get webhook task ${taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  private getEmailTaskTE(
    taskId: string
  ): TaskEither<TaskGetErrorEmailTask, Prisma.WorkflowActionsEmailTaskGetPayload<object>> {
    return TE.tryCatch(
      async () => {
        const task = await this.prisma.workflowActionsEmailTask.findUnique({
          where: {id: taskId}
        })
        if (!task) throw new TaskNotFoundError()
        return task
      },
      error => {
        if (error instanceof TaskNotFoundError) {
          Logger.warn(`Task ${taskId} not found`)
          return "task_not_found" as const
        }

        Logger.error(`Failed to get email task ${taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  lockTask(taskReference: TaskReference, lockOwner: string): TaskEither<TaskLockError, Occ> {
    // This method is a generic method to lock any task type.
    // Since the tasks are stored in different tables, we need to handle each type separately.

    const {type, taskId} = taskReference

    return TE.tryCatch(
      async () => {
        if (type === WorkflowActionType.EMAIL) {
          const updatedTasks = await this.prisma.workflowActionsEmailTask.updateManyAndReturn({
            where: {id: taskId, lockedBy: null},
            data: {lockedBy: lockOwner, lockedAt: new Date(), occ: {increment: 1}}
          })

          if (updatedTasks.length === 0 || updatedTasks[0] === undefined) {
            const task = await this.prisma.workflowActionsEmailTask.findUnique({where: {id: taskId}})
            if (!task) throw new TaskNotFoundError()
            if (task.lockedBy === lockOwner) return {occ: task.occ}
            throw new TaskLockedByOtherError()
          }

          return {occ: updatedTasks[0].occ}
        } else {
          const updatedTasks = await this.prisma.workflowActionsWebhookTask.updateManyAndReturn({
            where: {id: taskId, lockedBy: null},
            data: {lockedBy: lockOwner, lockedAt: new Date(), occ: {increment: 1}}
          })

          if (updatedTasks.length === 0 || updatedTasks[0] === undefined) {
            const task = await this.prisma.workflowActionsWebhookTask.findUnique({where: {id: taskId}})
            if (!task) throw new TaskNotFoundError()
            if (task.lockedBy === lockOwner) return {occ: task.occ}
            throw new TaskLockedByOtherError()
          }

          return {occ: updatedTasks[0].occ}
        }
      },
      error => {
        if (error instanceof TaskLockedByOtherError) return "task_locked_by_other" as const
        if (error instanceof TaskNotFoundError) {
          Logger.error(`Task ${taskId} not found during lock attempt`)
          return "task_not_found" as const
        }
        Logger.error(`Failed to lock task ${taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  releaseLock(taskReference: TaskReference, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    // This method is a generic method to lock any task type.
    // Since the tasks are stored in different tables, we need to handle each type separately.

    const {type, taskId} = taskReference

    return TE.tryCatch(
      async () => {
        const baseData = {
          lockedBy: null,
          lockedAt: null,
          occ: {increment: 1}
        }

        if (type === WorkflowActionType.EMAIL) {
          const result = await this.prisma.workflowActionsEmailTask.updateMany({
            where: {id: taskId, occ: checks.occ, lockedBy: checks.lockOwner},
            data: baseData
          })
          if (result.count === 0) await this.categorizeErrorTypeAndRaise("WorkflowActionsEmailTask", taskId, checks)
        } else {
          // WorkflowActionType.WEBHOOK
          const result = await this.prisma.workflowActionsWebhookTask.updateMany({
            where: {id: taskId, occ: checks.occ, lockedBy: checks.lockOwner},
            data: baseData
          })
          if (result.count === 0) await this.categorizeErrorTypeAndRaise("WorkflowActionsWebhookTask", taskId, checks)
        }
      },
      error => {
        if (error instanceof ConcurrentUpdateError) return "task_concurrent_update" as const
        if (error instanceof TaskNotFoundError) return "task_concurrent_update" as const
        if (error instanceof TaskLockedByOtherError) return "task_locked_by_other" as const
        Logger.error(`Failed to release lock for task ${taskId}`, error)
        return "unknown_error" as const
      }
    )
  }

  private async categorizeErrorTypeAndRaise(
    table: Extract<Prisma.ModelName, "WorkflowActionsEmailTask" | "WorkflowActionsWebhookTask">,
    id: string,
    checks: TaskUpdateChecks
  ): Promise<never> {
    Logger.error(`Failed to update task ${id}: no records have been updated`)

    const retrievers = {
      WorkflowActionsEmailTask: () => this.prisma.workflowActionsEmailTask.findUnique({where: {id}}),
      WorkflowActionsWebhookTask: () => this.prisma.workflowActionsWebhookTask.findUnique({where: {id}})
    }

    let actualTask

    try {
      actualTask = await retrievers[table]()
    } catch {
      throw new TaskUnknownError()
    }

    if (!actualTask) throw new TaskNotFoundError()
    if (actualTask.lockedBy !== checks.lockOwner) throw new TaskLockedByOtherError()
    if (actualTask.occ !== checks.occ) throw new ConcurrentUpdateError()

    throw new TaskUnknownError()
  }
}

function mapHeadersToJsonValue(
  headers?: Record<string, string>
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (!headers) return Prisma.JsonNull
  const result: Record<string, Prisma.InputJsonValue | null> = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value
  }
  return result
}

function mapHeadersToRecord(headers: Prisma.JsonValue): Record<string, string> {
  if (headers === undefined || headers === null) return {}

  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    result[key] = value
  }
  return result
}

function extractResponseAttributes(task: DecoratedWorkflowActionWebhookTask<object>) {
  if (task.status === TaskStatus.ERROR) {
    return {
      responseStatus: task.response?.status,
      responseBody: task.response?.body,
      responseBodyStatus: task.response?.bodyStatus
    }
  }

  if (task.status === TaskStatus.COMPLETED) {
    return {
      responseStatus: task.response.status,
      responseBody: task.response.body,
      responseBodyStatus: task.response.bodyStatus
    }
  }

  return {
    responseStatus: undefined,
    responseBody: undefined,
    responseBodyStatus: undefined
  }
}
