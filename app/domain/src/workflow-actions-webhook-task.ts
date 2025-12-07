import {randomUUID} from "crypto"
import {Either, isLeft, right} from "fp-ts/lib/Either"
import {DecorableEntity, PrefixUnion, isDecoratedWith} from "@utils"
import {
  Lock,
  TaskStatus,
  validateLock,
  validateTaskStatus,
  validateErrorReason,
  mapLockErrorWithPrefix,
  WorkflowActionTaskData
} from "./workflow-actions-shared"
import {WebhookActionHttpMethod} from "./workflow-actions"

export type WorkflowActionWebhookTask =
  | WorkflowActionWebhookTaskPending
  | WorkflowActionWebhookTaskCompleted
  | WorkflowActionWebhookTaskError

export interface WorkflowActionWebhookTaskData extends WorkflowActionTaskData {
  url: string
  method: WebhookActionHttpMethod
  headers?: Record<string, string>
  payload?: unknown
}

export interface WorkflowActionWebhookTaskPending extends WorkflowActionWebhookTaskData {
  status: TaskStatus.PENDING
}

export interface WorkflowActionWebhookTaskCompleted extends WorkflowActionWebhookTaskData {
  status: TaskStatus.COMPLETED
  responseStatus: number
  responseBody: string
}

export interface WorkflowActionWebhookTaskError extends WorkflowActionWebhookTaskData {
  status: TaskStatus.ERROR
  responseStatus?: number
  responseBody?: string
  errorReason: string
}

export interface WorkflowActionWebhookTaskDecorators {
  occ: bigint
  lock: Lock
}

export type WorkflowActionWebhookTaskDecoratorSelector = Partial<
  Record<keyof WorkflowActionWebhookTaskDecorators, boolean>
>

export type DecoratedWorkflowActionWebhookTask<T extends WorkflowActionWebhookTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionWebhookTask,
  WorkflowActionWebhookTaskDecorators,
  T
>

export function isDecoratedWorkflowActionWebhookTask<K extends keyof WorkflowActionWebhookTaskDecorators>(
  task: DecoratedWorkflowActionWebhookTask<WorkflowActionWebhookTaskDecoratorSelector>,
  key: K,
  options?: WorkflowActionWebhookTaskDecoratorSelector
): task is DecoratedWorkflowActionWebhookTask<WorkflowActionWebhookTaskDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedWorkflowActionWebhookTask<WorkflowActionWebhookTaskDecoratorSelector>,
    WorkflowActionWebhookTaskDecorators,
    WorkflowActionWebhookTaskDecoratorSelector,
    keyof WorkflowActionWebhookTaskDecorators
  >(task, key, options)
}

export type WorkflowActionWebhookTaskValidationError = PrefixUnion<
  "workflow_action_webhook_task",
  UnprefixedWorkflowActionWebhookTaskValidationError
>

type UnprefixedWorkflowActionWebhookTaskValidationError =
  | "status_invalid"
  | "error_reason_too_long"
  | "lock_date_prior_creation"
  | "lock_by_too_long"
  | "lock_by_is_empty"
  | "lock_by_invalid_format"

export class WorkflowActionWebhookTaskFactory {
  static validate<T extends WorkflowActionWebhookTaskDecoratorSelector>(
    task: Omit<DecoratedWorkflowActionWebhookTask<T>, "status"> & {
      status: string
    }
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookTask<T>> {
    return WorkflowActionWebhookTaskFactory.instantiateWorkflowActionWebhook(task)
  }

  static newWorkflowActionWebhookTask(
    data: Omit<
      WorkflowActionWebhookTaskPending,
      "id" | "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason"
    >
  ): DecoratedWorkflowActionWebhookTask<{occ: true}> {
    const uuid = randomUUID()
    const now = new Date()

    const baseEntity: WorkflowActionWebhookTaskPending = {
      ...data,
      id: uuid,
      status: TaskStatus.PENDING,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }

    const decoratedEntity: DecoratedWorkflowActionWebhookTask<{occ: true}> = {
      ...baseEntity,
      occ: 0n
    } as DecoratedWorkflowActionWebhookTask<{occ: true}>

    return decoratedEntity
  }

  private static instantiateWorkflowActionWebhook<T extends WorkflowActionWebhookTaskDecoratorSelector>(
    dataToBeValidated: Omit<DecoratedWorkflowActionWebhookTask<T>, "status"> & {
      status: string
    }
  ): Either<WorkflowActionWebhookTaskValidationError, DecoratedWorkflowActionWebhookTask<T>> {
    const statusValidation = validateTaskStatus(dataToBeValidated.status, "workflow_action_webhook_task_status_invalid")
    if (isLeft(statusValidation)) return statusValidation

    const errorReasonValidation = validateErrorReason(
      dataToBeValidated.errorReason,
      "workflow_action_webhook_task_error_reason_too_long"
    )
    if (isLeft(errorReasonValidation)) return errorReasonValidation

    const dataWithTypedStatus = {...dataToBeValidated, status: statusValidation.right}

    const isDecoratedWithOcc = isDecoratedWorkflowActionWebhookTask(
      dataWithTypedStatus as unknown as DecoratedWorkflowActionWebhookTask<WorkflowActionWebhookTaskDecoratorSelector>,
      "occ",
      {
        occ: true
      }
    )

    const isDecoratedWithLock = isDecoratedWorkflowActionWebhookTask(
      dataWithTypedStatus as unknown as DecoratedWorkflowActionWebhookTask<WorkflowActionWebhookTaskDecoratorSelector>,
      "lock",
      {
        lock: true
      }
    )

    if (isDecoratedWithLock) {
      const lockValidation = validateLock(
        (dataWithTypedStatus as unknown as {lock: Lock}).lock,
        dataWithTypedStatus.createdAt
      )
      if (isLeft(lockValidation))
        return mapLockErrorWithPrefix<WorkflowActionWebhookTaskValidationError>(
          lockValidation.left,
          "workflow_action_webhook_task"
        )
    }

    const task = {
      ...dataWithTypedStatus,
      occ: isDecoratedWithOcc ? (dataWithTypedStatus as unknown as {occ: bigint}).occ : undefined,
      lock: isDecoratedWithLock ? (dataWithTypedStatus as unknown as {lock: Lock}).lock : undefined
    } as unknown as DecoratedWorkflowActionWebhookTask<T>

    return right(task)
  }
}
