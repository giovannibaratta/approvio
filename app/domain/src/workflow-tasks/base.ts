/**
 * This file contains the base types and factories (validation and initialization) for workflow action tasks.
 * The specific tasks (e.g. sending email, calling webhook)can extend this base types and factories to add task specific attributes.
 */

import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {
  DecorableEntity,
  GeneratorSelector,
  PrefixUnion,
  getStringAsEnum,
  hasOwnProperty,
  isDate,
  isDecoratedWith
} from "@utils"

import {mapToLeftWithPrefix} from "@utils"

export enum TaskStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR"
}

export type WorkflowActionTaskDecoratorSelector = GeneratorSelector<WorkflowActionTaskDecorators>

export type DecoratedWorkflowActionTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type WorkflowActionTaskData =
  | WorkflowActionPendingTaskData
  | WorkflowActionCompletedTaskData
  | WorkflowActionErrorTaskData

interface WorkflowActionTaskBaseData {
  createdAt: Date
  id: string
  retryCount: number
  status: TaskStatus
  updatedAt: Date
  workflowId: string
}

export interface WorkflowActionPendingTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.PENDING
  retryCount: 0
}

export interface WorkflowActionCompletedTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.COMPLETED
}

export interface WorkflowActionErrorTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.ERROR
  errorReason: string
}

export type Lock = {
  lockedBy: string
  lockedAt: Date
}

export interface WorkflowActionTaskDecorators {
  occ: bigint
  lock: Lock
}

export type WorkflowActionTaskValidationError = PrefixUnion<
  "workflow_action_task",
  UnprefixedWorkflowActionTaskValidationError
>

type UnprefixedWorkflowActionTaskValidationError =
  | LockValidationError
  | StructureValidationError
  | ErrorReasonValidationError

type StructureValidationError =
  | "missing_or_invalid_status"
  | "missing_or_invalid_method"
  | "missing_or_invalid_id"
  | "missing_or_invalid_workflow_id"
  | "missing_or_invalid_created_at"
  | "missing_or_invalid_updated_at"
  | "missing_or_invalid_retry_count"
  | "missing_or_invalid_error_reason"

type ErrorReasonValidationError = "error_reason_too_long" | "error_reason_is_empty" | "error_reason_not_defined"

export type LockValidationError =
  | "lock_date_prior_creation"
  | "lock_by_too_long"
  | "lock_by_is_empty"
  | "lock_by_invalid_format"

export const MAX_LOCK_BY_LENGTH = 1024
export const MAX_ERROR_REASON_LENGTH = 16384

export function validateLock(lock: Lock, createdAt: Date): Either<LockValidationError, Lock> {
  if (lock.lockedAt < createdAt) return left("lock_date_prior_creation")
  if (lock.lockedBy.length > MAX_LOCK_BY_LENGTH) return left("lock_by_too_long")
  if (lock.lockedBy.trim().length === 0) return left("lock_by_is_empty")

  // Must start with [a-zA-Z]
  // Must end with [a-zA-Z0-9]
  // Can contain a dash
  // Can not contain two consecutive dashses
  const lockByRegex = /^[a-zA-Z](-?[a-zA-Z0-9]+)*$/
  if (!lockByRegex.test(lock.lockedBy)) return left("lock_by_invalid_format")

  return right(lock)
}

export function validateTaskStatus<E extends string>(status: string, invalidStatusError: E): Either<E, TaskStatus> {
  const enumStatus = getStringAsEnum(status, TaskStatus)
  if (enumStatus === undefined) return left(invalidStatusError)
  return right(enumStatus)
}

export function validateErrorReason(
  errorReason: string | undefined | null
): Either<ErrorReasonValidationError, WorkflowActionErrorTaskData["errorReason"]> {
  if (errorReason === undefined || errorReason === null) return left("error_reason_not_defined")

  const trimmed = errorReason.trim()

  if (trimmed.length === 0) return left("error_reason_is_empty")
  if (trimmed.length > MAX_ERROR_REASON_LENGTH) return left("error_reason_too_long")
  return right(trimmed)
}

export class WorkflowActionTaskFactory {
  /**
   * Validates and constructs a workflow action task from raw data.
   *
   * Performs comprehensive validation of workflow action task data including base properties,
   * status-specific requirements, and optional decorators. Returns a fully validated task object
   * or detailed validation errors.
   *
   * @param dataToBeValidated - Raw object containing workflow task data to validate
   * @returns Either a WorkflowActionTaskValidationError on validation failure or a validated
   *          DecoratedWorkflowActionTask on success. Preserves unknown properties in the result.
   *
   * @example
   * ```typescript
   * const result = WorkflowActionTaskFactory.validate({
   *   id: "task-123",
   *   workflowId: "workflow-456",
   *   status: "PENDING",
   *   retryCount: 0,
   *   createdAt: new Date(),
   *   updatedAt: new Date(),
   *   occ: 123n
   * })
   * // Returns: right(validatedTask) or left(validationError)
   * ```
   */
  static validate<T extends WorkflowActionTaskDecoratorSelector>(
    dataToBeValidated: object
  ): Either<WorkflowActionTaskValidationError, DecoratedWorkflowActionTask<T>> {
    if (!hasOwnProperty(dataToBeValidated, "status") || typeof dataToBeValidated.status !== "string")
      return left("workflow_action_task_missing_or_invalid_status")

    const statusValidation = validateTaskStatus(
      dataToBeValidated.status,
      "workflow_action_task_missing_or_invalid_status"
    )
    if (isLeft(statusValidation)) return statusValidation

    if (!hasOwnProperty(dataToBeValidated, "id") || typeof dataToBeValidated.id !== "string")
      return left("workflow_action_task_missing_or_invalid_id")

    if (!hasOwnProperty(dataToBeValidated, "workflowId") || typeof dataToBeValidated.workflowId !== "string")
      return left("workflow_action_task_missing_or_invalid_workflow_id")

    if (!hasOwnProperty(dataToBeValidated, "createdAt") || !isDate(dataToBeValidated.createdAt))
      return left("workflow_action_task_missing_or_invalid_created_at")

    if (!hasOwnProperty(dataToBeValidated, "updatedAt") || !isDate(dataToBeValidated.updatedAt))
      return left("workflow_action_task_missing_or_invalid_updated_at")

    if (!hasOwnProperty(dataToBeValidated, "retryCount") || typeof dataToBeValidated.retryCount !== "number")
      return left("workflow_action_task_missing_or_invalid_retry_count")

    const unvalidatedBaseData: WorkflowActionTaskBaseData = {
      // We need to preserve all the data from the original object while only keeping the validated
      // properties. Otherwise they will be stripped an lost at each stage of the validation, making
      // subsequent validations fail.
      ...dataToBeValidated,
      id: dataToBeValidated.id,
      workflowId: dataToBeValidated.workflowId,
      status: statusValidation.right,
      createdAt: dataToBeValidated.createdAt,
      updatedAt: dataToBeValidated.updatedAt,
      retryCount: dataToBeValidated.retryCount
    }

    let eitherTaskData: Either<WorkflowActionTaskValidationError, WorkflowActionTaskData>

    switch (unvalidatedBaseData.status) {
      case TaskStatus.PENDING:
        eitherTaskData = this.validatePendingTaskData({...unvalidatedBaseData, status: TaskStatus.PENDING})
        break
      case TaskStatus.COMPLETED:
        eitherTaskData = this.validateCompletedTaskData({...unvalidatedBaseData, status: TaskStatus.COMPLETED})
        break
      case TaskStatus.ERROR:
        eitherTaskData = this.validateErrorTaskData({...unvalidatedBaseData, status: TaskStatus.ERROR})
        break
    }

    if (isLeft(eitherTaskData)) return eitherTaskData

    const taskData = eitherTaskData.right

    const isDecoratedWithOcc = isDecoratedWorkflowActionTask(taskData, "occ", {
      occ: true
    })

    const isDecoratedWithLock = isDecoratedWorkflowActionTask(taskData, "lock", {
      lock: true
    })

    if (isDecoratedWithLock) {
      const lockValidation = validateLock(taskData.lock, taskData.createdAt)
      if (isLeft(lockValidation))
        return mapToLeftWithPrefix<LockValidationError, WorkflowActionTaskValidationError>(
          lockValidation.left,
          "workflow_action_task"
        )
    }

    const decoratedTask = {
      ...taskData,
      occ: isDecoratedWithOcc ? taskData.occ : undefined,
      lock: isDecoratedWithLock ? taskData.lock : undefined
    }

    return right(decoratedTask)
  }

  private static validatePendingTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.PENDING} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionPendingTaskData> {
    if (dataToBeValidated.retryCount !== 0) return left("workflow_action_task_missing_or_invalid_retry_count")

    return right({...dataToBeValidated, retryCount: 0})
  }

  private static validateCompletedTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.COMPLETED} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionCompletedTaskData> {
    return right({...dataToBeValidated})
  }

  private static validateErrorTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.ERROR} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionErrorTaskData> {
    if (!hasOwnProperty(dataToBeValidated, "errorReason") || typeof dataToBeValidated.errorReason !== "string")
      return left("workflow_action_task_missing_or_invalid_error_reason")

    const errorReasonValidation = validateErrorReason(dataToBeValidated.errorReason)
    if (isLeft(errorReasonValidation))
      return mapToLeftWithPrefix<ErrorReasonValidationError, WorkflowActionTaskValidationError>(
        errorReasonValidation.left,
        "workflow_action_task"
      )

    return right({...dataToBeValidated, errorReason: errorReasonValidation.right})
  }
}

export function isDecoratedWorkflowActionTask<K extends keyof WorkflowActionTaskDecorators>(
  task: DecoratedWorkflowActionTask<WorkflowActionTaskDecoratorSelector>,
  key: K,
  options?: WorkflowActionTaskDecoratorSelector
): task is DecoratedWorkflowActionTask<WorkflowActionTaskDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedWorkflowActionTask<WorkflowActionTaskDecoratorSelector>,
    WorkflowActionTaskDecorators,
    WorkflowActionTaskDecoratorSelector,
    keyof WorkflowActionTaskDecorators
  >(task, key, options)
}
