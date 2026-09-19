import {TaskEither} from "fp-ts/TaskEither"
import {
  DecoratedWorkflowActionWebhookTask,
  DecoratedWorkflowActionEmailTask,
  DecoratedWorkflowActionSlackTask,
  DecoratedWorkflowActionSlackPendingTask,
  WorkflowActionWebhookTaskValidationError,
  WorkflowActionEmailTaskValidationError,
  WorkflowActionSlackTaskValidationError,
  DecoratedWorkflowActionWebhookPendingTask,
  BoundaryError,
  TenantContext,
  TaskReadyEvent,
  TaskCreation
} from "@domain"
import {UnknownError} from "@services/error"
import {CryptoError} from "@services/encryption/interfaces"

export type TaskAlreadyExists = "task_already_exists"
type TaskNotFoundError = "task_not_found"
export type TaskLoadStorageError =
  /** A database-confirmed serialization/write conflict; the owning transaction retries. */
  | "task_load_transaction_conflict"
  /** A recognized connection, timeout or capacity failure eligible for a bounded queue retry. */
  | "task_load_temporarily_unavailable"
  /** An unexpected storage failure; preserve its cause in internal logs without assuming it is transient. */
  | "task_load_storage_error"

/** Retryability is classified by the external adapter; callers preserve the code for diagnostics. */
export interface TaskLoadFailure<Code extends string> {
  readonly code: Code
  readonly retryable: boolean
}

export type TaskGetErrorWebhookTask = TaskLoadFailure<
  | BoundaryError
  | CryptoError
  | WorkflowActionWebhookTaskValidationError
  | TaskNotFoundError
  | TaskLoadStorageError
  | "task_payload_invalid"
>

export type TaskGetErrorEmailTask = TaskLoadFailure<
  | BoundaryError
  | CryptoError
  | WorkflowActionEmailTaskValidationError
  | TaskNotFoundError
  | TaskLoadStorageError
  | "task_payload_invalid"
>

export type TaskGetErrorSlackTask = TaskLoadFailure<
  | BoundaryError
  | CryptoError
  | WorkflowActionSlackTaskValidationError
  | TaskNotFoundError
  | TaskLoadStorageError
  | "task_payload_invalid"
>

export type TaskCreateError =
  BoundaryError | CryptoError | UnknownError | TaskAlreadyExists | "event_mismatch" | "repository_dependency_error"

export const TASK_REPOSITORY_TOKEN = Symbol("TASK_REPOSITORY_TOKEN")

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

interface TaskCreateRequest<T> {
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

/**
 * Persists and retrieves email, webhook, and Slack workflow tasks.
 * For new tasks, each create operation atomically inserts the task, durable work, and task-ready
 * outbox record supplied by the service. The repository encrypts task payloads.
 * The service validates task ownership against context before calling these methods.
 * Reads return task-row snapshots; DispatchService owns the live durable-work lifecycle.
 */
export interface TaskRepository {
  // TODO: Wouldn't be better to return a left if there is a duplicate value ?
  /**
   * Persists one task, its durable work and task-ready outbox event atomically.
   * An existing task with the same source event, action index and kind returns
   * undefined; a mismatch returns event_mismatch. The service owns generation receipts.
   */
  createEventTask(
    context: TenantContext,
    request: TaskGenerationRequest,
    creation: TaskCreation
  ): TaskEither<TaskCreateError, TaskReadyEvent | undefined>

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
   * Retrieves a slack task by its ID.
   * @param taskId The unique identifier of the slack task.
   * @returns A TaskEither containing the decorated slack task or a TaskGetErrorSlackTask.
   */
  getSlackTask(
    context: TenantContext,
    taskId: string
  ): TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>>
}
