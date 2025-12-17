import {TaskEither} from "fp-ts/TaskEither"
import {
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookPendingTask,
  DecoratedWorkflowActionWebhookTask,
  Occ,
  WorkflowActionEmailTask,
  WorkflowActionTaskDecoratorSelector
} from "@domain"
import {UnknownError} from "@services/error"

export type TaskAlreadyExists = "task_already_exists"
export type TaskConcurrentUpdateError = "task_concurrent_update"
export type TaskLockedByOtherError = "task_locked_by_other"
export type TaskCreateError = UnknownError | TaskAlreadyExists
export type TaskUpdateError = UnknownError | TaskConcurrentUpdateError | TaskLockedByOtherError

export const TASK_REPOSITORY_TOKEN = Symbol("TASK_REPOSITORY_TOKEN")

export interface TaskUpdateChecks {
  occ: bigint
  lockOwner: string
}

export interface TaskRepository {
  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void>
  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>
}
