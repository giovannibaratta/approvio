import {randomUUID} from "crypto"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {DecorableEntity, PrefixUnion, getStringAsEnum, isDecoratedWith} from "@utils"

export enum TaskStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR"
}

export type WorkflowActionEmailTask = Readonly<WorkflowActionEmailTaskData>

interface WorkflowActionEmailTaskData {
  id: string
  workflowId: string
  status: TaskStatus
  configuration: Record<string, unknown>
  retryCount: number
  errorReason?: string
  createdAt: Date
  updatedAt: Date
}

export type Lock = {
  lockedBy: string
  lockedAt: Date
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
    data: Omit<WorkflowActionEmailTaskData, "id" | "status" | "retryCount" | "createdAt" | "updatedAt" | "errorReason">
  ): DecoratedWorkflowActionEmailTask<{occ: true}> {
    const uuid = randomUUID()
    const now = new Date()

    const baseEntity: WorkflowActionEmailTask = {
      ...data,
      id: uuid,
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
    const statusValidation = validateTaskStatus(dataToBeValidated.status)
    if (isLeft(statusValidation)) {
      return statusValidation
    }

    if (dataToBeValidated.errorReason && dataToBeValidated.errorReason.length > 16384) {
      return left("workflow_action_email_task_error_reason_too_long")
    }

    const dataWithTypedStatus = {...dataToBeValidated, status: statusValidation.right}

    const isDecoratedWithOcc = isDecoratedWorkflowActionEmailTask(dataWithTypedStatus, "occ", {
      occ: true
    })

    const isDecoratedWithLock = isDecoratedWorkflowActionEmailTask(dataWithTypedStatus, "lock", {
      lock: true
    })

    if (isDecoratedWithLock) {
      const lockValidation = validateLock(dataWithTypedStatus.lock, dataWithTypedStatus.createdAt)
      if (isLeft(lockValidation)) return lockValidation
    }

    const task: WorkflowActionEmailTask = {
      ...dataWithTypedStatus,
      occ: isDecoratedWithOcc ? dataWithTypedStatus.occ : undefined,
      lock: isDecoratedWithLock ? dataWithTypedStatus.lock : undefined
    }

    return right(task as DecoratedWorkflowActionEmailTask<T>)
  }
}

function validateTaskStatus(status: string): Either<WorkflowActionEmailTaskValidationError, TaskStatus> {
  const enumStatus = getStringAsEnum(status, TaskStatus)
  if (enumStatus === undefined) {
    return left("workflow_action_email_task_status_invalid")
  }
  return right(enumStatus)
}

function validateLock(lock: Lock, createdAt: Date): Either<WorkflowActionEmailTaskValidationError, Lock> {
  if (lock.lockedAt < createdAt) {
    return left("workflow_action_email_task_lock_date_prior_creation")
  }

  if (lock.lockedBy.length > 1024) {
    return left("workflow_action_email_task_lock_by_too_long")
  }

  if (lock.lockedBy.trim().length === 0) {
    return left("workflow_action_email_task_lock_by_is_empty")
  }

  // Must start with [a-zA-Z]
  // Must end with [a-zA-Z0-9]
  // Can contain a dash
  // Can not contain two consecutive dashses
  const lockByRegex = /^[a-zA-Z](-?[a-zA-Z0-9]+)*$/
  if (!lockByRegex.test(lock.lockedBy)) {
    return left("workflow_action_email_task_lock_by_invalid_format")
  }

  return right(lock)
}
