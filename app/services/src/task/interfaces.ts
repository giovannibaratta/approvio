import {TaskEither} from "fp-ts/TaskEither"
import {
  WorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionType,
  DecoratedWorkflowActionEmailTask,
  Occ,
  WorkflowActionWebhookTaskValidationError,
  WorkflowActionEmailTaskValidationError,
  WorkflowActionTaskDecoratorSelector,
  DecoratedWorkflowActionWebhookPendingTask
} from "@domain"
import {UnknownError} from "@services/error"

export type TaskAlreadyExists = "task_already_exists"
export type TaskConcurrentUpdateError = "task_concurrent_update"
export type TaskLockedByOtherError = "task_locked_by_other"
type TaskNotFoundError = "task_not_found"
type TaskLockInconsistentError = "task_lock_inconsistent"

export type TaskGetErrorWebhookTask =
  | UnknownError
  | WorkflowActionWebhookTaskValidationError
  | TaskNotFoundError
  | TaskLockInconsistentError

export type TaskGetErrorEmailTask =
  | UnknownError
  | WorkflowActionEmailTaskValidationError
  | TaskNotFoundError
  | TaskLockInconsistentError

export type TaskCreateError = UnknownError | TaskAlreadyExists
export type TaskUpdateError = UnknownError | TaskConcurrentUpdateError | TaskLockedByOtherError
export type TaskLockError = TaskNotFoundError | TaskLockedByOtherError | UnknownError

export const TASK_REPOSITORY_TOKEN = Symbol("TASK_REPOSITORY_TOKEN")

/**
 * Checks to perform when updating a task to ensure the task is not modified by another process.
 */
export interface TaskUpdateChecks {
  /** Optimistic Concurrency Control version. */
  occ: bigint
  /** The identifier of the owner that is expected to hold the lock. */
  lockOwner: string
}

/**
 * Uniquely identifies a task by its type and ID.
 */
export interface TaskReference {
  /** The type of workflow action associated with the task. */
  type: WorkflowActionType
  /** The unique identifier of the task. */
  taskId: string
}

/**
 * Repository for managing workflow tasks, including email and webhook tasks.
 * Handles task creation, updates, locking, and retrieval.
 */
export interface TaskRepository {
  /**
   * Creates a new email task.
   * @param task The decorated email task data to create.
   * @returns A TaskEither indicating success or a TaskCreateError.
   */
  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void>

  /**
   * Updates an existing email task.
   * @param task The email task data with updated fields.
   * @param checks Concurrency and lock ownership checks.
   * @returns A TaskEither containing the updated OCC version or a TaskUpdateError.
   */
  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, Occ>

  /**
   * Creates a new webhook task in pending state.
   * @param task The decorated pending webhook task data to create.
   * @returns A TaskEither indicating success or a TaskCreateError.
   */
  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void>

  /**
   * Updates a webhook task.
   * @param task The decorated webhook task data (pending or completed).
   * @param checks Concurrency and lock ownership checks.
   * @returns A TaskEither containing the updated OCC version or a TaskUpdateError.
   */
  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>

  /**
   * Attempts to acquire a lock on a task.
   * @param taskReference The reference to the task to lock.
   * @param lockOwner The identifier of the entity requesting the lock.
   * @returns A TaskEither containing the current OCC version or a TaskLockError.
   */
  lockTask(taskReference: TaskReference, lockOwner: string): TaskEither<TaskLockError, Occ>

  /**
   * Releases a lock on a task.
   * @param taskReference The reference to the task to unlock.
   * @param checks Concurrency and lock ownership checks.
   * @returns A TaskEither indicating success or a TaskUpdateError.
   */
  releaseLock(taskReference: TaskReference, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void>

  /**
   * Retrieves a webhook task by its ID.
   * @param taskId The unique identifier of the webhook task.
   * @returns A TaskEither containing the decorated webhook task or a TaskGetErrorWebhookTask.
   */
  getWebhookTask(taskId: string): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>>

  /**
   * Retrieves an email task by its ID.
   * @param taskId The unique identifier of the email task.
   * @returns A TaskEither containing the decorated email task or a TaskGetErrorEmailTask.
   */
  getEmailTask(taskId: string): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>>
}
