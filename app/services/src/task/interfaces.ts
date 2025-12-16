import {TaskEither} from "fp-ts/TaskEither"
import {
  WorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionType,
  DecoratedWorkflowActionEmailTask,
  Occ,
  WorkflowActionWebhookTaskValidationError,
  WorkflowActionTaskDecoratorSelector,
  DecoratedWorkflowActionWebhookPendingTask
} from "@domain"
import {UnknownError} from "@services/error"

export type TaskAlreadyExists = "task_already_exists"
export type TaskConcurrentUpdateError = "task_concurrent_update"
export type TaskLockedByOtherError = "task_locked_by_other"
export type TaskGetErrorWebhookTask = UnknownError | WorkflowActionWebhookTaskValidationError
export type TaskCreateError = UnknownError | TaskAlreadyExists
export type TaskUpdateError = UnknownError | TaskConcurrentUpdateError | TaskLockedByOtherError
export type TaskLockError = "task_not_found" | TaskLockedByOtherError | UnknownError

export const TASK_REPOSITORY_TOKEN = Symbol("TASK_REPOSITORY_TOKEN")

export interface TaskUpdateChecks {
  occ: bigint
  lockOwner: string
}

export interface TaskReference {
  type: WorkflowActionType
  taskId: string
}

export interface TaskRepository {
  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void>
  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>
  lockTask(taskReference: TaskReference, lockOwner: string): TaskEither<TaskLockError, {occ: bigint}>
  releaseLock(taskReference: TaskReference, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void>
  getWebhookTask(taskId: string): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>>
}
