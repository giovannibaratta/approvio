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

export type WorkflowActionEmailTask = Readonly<WorkflowActionEmailTaskData>

interface WorkflowActionEmailTaskData extends WorkflowActionTaskData {
  recipients: string[]
  subject: string
  body: string
}

export interface WorkflowActionEmailTaskDecorators {
  occ: bigint
  lock: Lock
}

export type WorkflowActionEmailTaskDecoratorSelector = Partial<Record<keyof WorkflowActionEmailTaskDecorators, boolean>>

export type DecoratedWorkflowActionEmailTask<T extends WorkflowActionEmailTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionEmailTask,
  WorkflowActionEmailTaskDecorators,
  T
>

export function isDecoratedWorkflowActionEmailTask<K extends keyof WorkflowActionEmailTaskDecorators>(
  task: DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector>,
  key: K,
  options?: WorkflowActionEmailTaskDecoratorSelector
): task is DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedWorkflowActionEmailTask<WorkflowActionEmailTaskDecoratorSelector>,
    WorkflowActionEmailTaskDecorators,
    WorkflowActionEmailTaskDecoratorSelector,
    keyof WorkflowActionEmailTaskDecorators
  >(task, key, options)
}

export type WorkflowActionEmailTaskValidationError = PrefixUnion<
  "workflow_action_email_task",
  UnprefixedWorkflowActionEmailTaskValidationError
>

type UnprefixedWorkflowActionEmailTaskValidationError =
  | "status_invalid"
  | "error_reason_too_long"
  | "lock_date_prior_creation"
  | "lock_by_too_long"
  | "lock_by_is_empty"
  | "lock_by_invalid_format"

export class WorkflowActionEmailTaskFactory {
  static validate<T extends WorkflowActionEmailTaskDecoratorSelector>(
    task: Omit<DecoratedWorkflowActionEmailTask<T>, "status"> & {
      status: string
    }
  ): Either<WorkflowActionEmailTaskValidationError, DecoratedWorkflowActionEmailTask<T>> {
    return WorkflowActionEmailTaskFactory.instantiateWorkflowActionEmail(task)
  }

  static newWorkflowActionEmailTask(
    data: Omit<WorkflowActionEmailTaskData, "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason">
  ): DecoratedWorkflowActionEmailTask<{occ: true}> {
    const now = new Date()

    const baseEntity: WorkflowActionEmailTask = {
      ...data,
      status: TaskStatus.PENDING,
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    }

    const decoratedEntity: DecoratedWorkflowActionEmailTask<{occ: true}> = {
      ...baseEntity,
      occ: 0n
    } as DecoratedWorkflowActionEmailTask<{occ: true}>

    return decoratedEntity
  }

  private static instantiateWorkflowActionEmail<T extends WorkflowActionEmailTaskDecoratorSelector>(
    dataToBeValidated: Omit<DecoratedWorkflowActionEmailTask<T>, "status"> & {
      status: string
    }
  ): Either<WorkflowActionEmailTaskValidationError, DecoratedWorkflowActionEmailTask<T>> {
    const statusValidation = validateTaskStatus(dataToBeValidated.status, "workflow_action_email_task_status_invalid")
    if (isLeft(statusValidation)) return statusValidation

    const errorReasonValidation = validateErrorReason(
      dataToBeValidated.errorReason,
      "workflow_action_email_task_error_reason_too_long"
    )
    if (isLeft(errorReasonValidation)) return errorReasonValidation

    const dataWithTypedStatus = {...dataToBeValidated, status: statusValidation.right}

    const isDecoratedWithOcc = isDecoratedWorkflowActionEmailTask(dataWithTypedStatus, "occ", {
      occ: true
    })

    const isDecoratedWithLock = isDecoratedWorkflowActionEmailTask(dataWithTypedStatus, "lock", {
      lock: true
    })

    if (isDecoratedWithLock) {
      const lockValidation = validateLock(dataWithTypedStatus.lock, dataWithTypedStatus.createdAt)
      if (isLeft(lockValidation))
        return mapLockErrorWithPrefix<WorkflowActionEmailTaskValidationError>(
          lockValidation.left,
          "workflow_action_email_task"
        )
    }

    const task: WorkflowActionEmailTask = {
      ...dataWithTypedStatus,
      occ: isDecoratedWithOcc ? dataWithTypedStatus.occ : undefined,
      lock: isDecoratedWithLock ? dataWithTypedStatus.lock : undefined
    }

    return right(task as DecoratedWorkflowActionEmailTask<T>)
  }
}
