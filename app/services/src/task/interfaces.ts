import {TaskEither} from "fp-ts/TaskEither"
import {
  WorkflowActionEmailTask,
  DecoratedWorkflowActionWebhookTask,
  WorkflowActionType,
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionSlackTask,
  DecoratedWorkflowActionSlackPendingTask,
  Occ,
  WorkflowActionWebhookTaskValidationError,
  WorkflowActionEmailTaskValidationError,
  WorkflowActionSlackTaskValidationError,
  WorkflowActionTaskDecoratorSelector,
  DecoratedWorkflowActionWebhookPendingTask,
  BoundaryError,
  TenantContext,
  TaskReadyEvent
} from "@domain"
import {EncryptionError, UnknownError} from "@services/error"

export type TaskAlreadyExists = "task_already_exists"
export type TaskConcurrentUpdateError = "task_concurrent_update"
type TaskNotFoundError = "task_not_found"
type TaskLockInconsistentError = "task_lock_inconsistent"

export type TaskGetErrorWebhookTask =
  | BoundaryError
  | EncryptionError
  | UnknownError
  | WorkflowActionWebhookTaskValidationError
  | TaskNotFoundError
  | TaskLockInconsistentError

export type TaskGetErrorEmailTask =
  | BoundaryError
  | EncryptionError
  | UnknownError
  | WorkflowActionEmailTaskValidationError
  | TaskNotFoundError
  | TaskLockInconsistentError

export type TaskGetErrorSlackTask =
  | BoundaryError
  | EncryptionError
  | UnknownError
  | WorkflowActionSlackTaskValidationError
  | TaskNotFoundError
  | TaskLockInconsistentError

export type TaskCreateError =
  BoundaryError | EncryptionError | UnknownError | TaskAlreadyExists | "event_mismatch" | "repository_dependency_error"
export type TaskUpdateError = BoundaryError | EncryptionError | UnknownError | TaskConcurrentUpdateError | "lease_lost"

export const TASK_REPOSITORY_TOKEN = Symbol("TASK_REPOSITORY_TOKEN")

/**
 * Checks to perform when updating a task to ensure the task is not modified by another process.
 */
export interface TaskUpdateChecks {
  /** Must match the stored row version. Each update increments it. */
  occ: bigint
  /** Must match the current lease token. Claiming or invalidating a lease increments it. */
  fencing: bigint
  /** Must match the worker that holds the lease. */
  leaseOwner: string
}

export interface TaskPersistenceMetadata {
  readonly eventId: string
  /** Zero-based position in the generation event's action list; with tenant and event ID, identifies the action on replay. */
  readonly actionIndex: number
  /**
   * Outbox recovery may publish the task-ready event at or after this time.
   * Also stored on the task and durable work; direct dispatch does not check it.
   */
  readonly availableAt: Date
}

export interface TaskCreateRequest<T> {
  readonly task: T
  readonly metadata: TaskPersistenceMetadata
}

export type TaskGenerationRequest =
  | {
      readonly kind: "email"
      readonly request: TaskCreateRequest<DecoratedWorkflowActionEmailTask<{occ: true}>>
    }
  | {
      readonly kind: "webhook"
      readonly request: TaskCreateRequest<DecoratedWorkflowActionWebhookPendingTask<{occ: true}>>
    }
  | {
      readonly kind: "slack"
      readonly request: TaskCreateRequest<DecoratedWorkflowActionSlackPendingTask<{occ: true}>>
    }

/** Events returned only after task rows, outbox facts and the generation receipt commit. */
export interface TaskGenerationResult {
  readonly outcome: "new" | "duplicate"
  readonly events: ReadonlyArray<TaskReadyEvent>
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
 * Persists and retrieves email, webhook, and Slack workflow tasks.
 * Updates require OCC and lease fencing checks; DispatchService manages the lease lifecycle.
 */
export interface TaskRepository {
  createEventTasks(
    context: TenantContext,
    eventId: string,
    requests: ReadonlyArray<TaskGenerationRequest>
  ): TaskEither<TaskCreateError, TaskGenerationResult>

  /**
   * Creates a new email task.
   * @param request The task and its event, action index, and availability metadata.
   * @returns The task-ready event or a TaskCreateError.
   */
  createEmailTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionEmailTask<{occ: true}>>
  ): TaskEither<TaskCreateError, TaskReadyEvent>

  /**
   * Updates an existing email task.
   * @param task The email task data with updated fields.
   * @param checks Expected OCC version, lease owner, and fencing token.
   * @returns A TaskEither containing the updated OCC version or a TaskUpdateError.
   */
  updateEmailTask(
    context: TenantContext,
    task: WorkflowActionEmailTask,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>

  /**
   * Creates a new webhook task in pending state.
   * @param request The task and its event, action index, and availability metadata.
   * @returns The task-ready event or a TaskCreateError.
   */
  createWebhookTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionWebhookPendingTask<{occ: true}>>
  ): TaskEither<TaskCreateError, TaskReadyEvent>

  /**
   * Updates a webhook task.
   * @param task The decorated webhook task data (pending or completed).
   * @param checks Expected OCC version, lease owner, and fencing token.
   * @returns A TaskEither containing the updated OCC version or a TaskUpdateError.
   */
  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>

  /**
   * Retrieves a webhook task by its ID.
   * @param taskId The unique identifier of the webhook task.
   * @returns A TaskEither containing the decorated webhook task or a TaskGetErrorWebhookTask.
   */
  getWebhookTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>>

  /**
   * Retrieves an email task by its ID.
   * @param taskId The unique identifier of the email task.
   * @returns A TaskEither containing the decorated email task or a TaskGetErrorEmailTask.
   */
  getEmailTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>>

  /**
   * Creates a new slack task in pending state.
   * @param request The task and its event, action index, and availability metadata.
   * @returns The task-ready event or a TaskCreateError.
   */
  createSlackTask(
    context: TenantContext,
    request: TaskCreateRequest<DecoratedWorkflowActionSlackPendingTask<{occ: true}>>
  ): TaskEither<TaskCreateError, TaskReadyEvent>

  /**
   * Updates a slack task.
   * @param task The decorated slack task data (pending or completed).
   * @param checks Expected OCC version, lease owner, and fencing token.
   * @returns A TaskEither containing the updated OCC version or a TaskUpdateError.
   */
  updateSlackTask<T extends WorkflowActionTaskDecoratorSelector>(
    context: TenantContext,
    task: DecoratedWorkflowActionSlackTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>

  /**
   * Retrieves a slack task by its ID.
   * @param taskId The unique identifier of the slack task.
   * @returns A TaskEither containing the decorated slack task or a TaskGetErrorSlackTask.
   */
  getSlackTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>>
}
