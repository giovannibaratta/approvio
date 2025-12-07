import {Injectable, Logger} from "@nestjs/common"
import {TaskCreateError, TaskRepository, TaskUpdateChecks, TaskUpdateError} from "@services/task/interfaces"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionEmailTask,
  WorkflowActionWebhookTask
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {DatabaseClient} from "../database/database-client"
import {Prisma} from "@prisma/client"
import {ConcurrentUpdateError} from "./shared"
import {TaskLockedByOtherError, TaskNotFoundError, TaskUnknownError} from "./task.exceptions"
import {mapToJsonValue} from "./shared/json-mappers"

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
            errorReason: task.errorReason,
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

  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    return TE.tryCatch(
      async () => {
        const result = await this.prisma.workflowActionsEmailTask.updateMany({
          where: {
            id: task.id,
            occ: checks.occ,
            lockedBy: checks.lockOwner
          },
          data: {
            status: task.status,
            retryCount: task.retryCount,
            errorReason: task.errorReason,
            updatedAt: task.updatedAt,
            occ: {increment: 1}
          }
        })

        if (result.count === 0) await this.categorizeErrorTypeAndRaise("WorkflowActionsEmailTask", task.id, checks)
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

  createWebhookTask(task: DecoratedWorkflowActionWebhookTask<{occ: true}>): TaskEither<TaskCreateError, void> {
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
            payload: mapPayloadToJsonValue(task.payload),
            responseStatus: (task as {responseStatus?: number}).responseStatus,
            responseBody: (task as {responseBody?: string}).responseBody,
            retryCount: task.retryCount,
            errorReason: task.errorReason,
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

  updateWebhookTask(task: WorkflowActionWebhookTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void> {
    return TE.tryCatch(
      async () => {
        const result = await this.prisma.workflowActionsWebhookTask.updateMany({
          where: {
            id: task.id,
            occ: checks.occ,
            lockedBy: checks.lockOwner
          },
          data: {
            status: task.status,
            retryCount: task.retryCount,
            errorReason: task.errorReason,
            responseStatus: (task as {responseStatus?: number}).responseStatus,
            responseBody: (task as {responseBody?: string}).responseBody,
            updatedAt: task.updatedAt,
            occ: {increment: 1}
          }
        })

        if (result.count === 0) await this.categorizeErrorTypeAndRaise("WorkflowActionsWebhookTask", task.id, checks)
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

  private async categorizeErrorTypeAndRaise(
    table: Extract<Prisma.ModelName, "WorkflowActionsEmailTask" | "WorkflowActionsWebhookTask">,
    id: string,
    checks: TaskUpdateChecks
  ) {
    const retrievers = {
      WorkflowActionsEmailTask: () => this.prisma.workflowActionsEmailTask.findUnique({where: {id}}),
      WorkflowActionsWebhookTask: () => this.prisma.workflowActionsWebhookTask.findUnique({where: {id}})
    }

    const actualTask = await retrievers[table]()

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

function mapPayloadToJsonValue(payload?: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (payload === undefined) return Prisma.JsonNull
  return mapToJsonValue(payload) ?? Prisma.JsonNull
}
