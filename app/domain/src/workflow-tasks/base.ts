import {OrganizationId, isOrganizationId} from "../shared"
/**
 * This file contains the base types and factories (validation and initialization) for workflow action tasks.
 * The specific tasks (e.g. sending email, calling webhook)can extend this base types and factories to add task specific attributes.
 */

import {Either, isLeft, left, right} from "fp-ts/Either"
import {
  DecorableEntity,
  GeneratorSelector,
  PrefixUnion,
  getStringAsEnum,
  hasOwnProperty,
  isDate,
  isDecoratedWith,
  isObject
} from "@utils"

import {mapToLeftWithPrefix} from "@utils"

export enum TaskStatus {
  READY = "ready",
  CLAIMED = "claimed",
  EXECUTING = "executing",
  SUCCEEDED = "succeeded",
  RETRY_DUE = "retry_due",
  FAILED = "failed",
  UNKNOWN = "unknown",
  PAUSED = "paused"
}

export type WorkflowActionTaskDecoratorSelector = GeneratorSelector<WorkflowActionTaskDecorators>

export type DecoratedWorkflowActionTask<T extends WorkflowActionTaskDecoratorSelector> = DecorableEntity<
  WorkflowActionTaskData,
  WorkflowActionTaskDecorators,
  T
>

export type WorkflowActionTaskData =
  | WorkflowActionPendingTaskData
  | WorkflowActionUnresolvedTaskData
  | WorkflowActionCompletedTaskData
  | WorkflowActionErrorTaskData

interface WorkflowActionTaskBaseData {
  createdAt: Date
  id: string
  organizationId: OrganizationId
  retryCount: number
  status: TaskStatus
  updatedAt: Date
  workflowId: string
}

export interface WorkflowActionPendingTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.READY
}

export interface WorkflowActionUnresolvedTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.CLAIMED | TaskStatus.EXECUTING | TaskStatus.RETRY_DUE | TaskStatus.UNKNOWN | TaskStatus.PAUSED
}

export interface WorkflowActionCompletedTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.SUCCEEDED
}

export interface WorkflowActionErrorTaskData extends WorkflowActionTaskBaseData {
  status: TaskStatus.FAILED
  errorReason?: string
}

export type Lock = {
  lockedBy: string
  lockedAt: Date
}

export interface WorkflowActionTaskDecorators {
  occ: bigint
  lock?: Lock
}

export type WorkflowActionTaskValidationError = PrefixUnion<
  "workflow_action_task",
  UnprefixedWorkflowActionTaskValidationError
>

type UnprefixedWorkflowActionTaskValidationError =
  LockValidationError | StructureValidationError | ErrorReasonValidationError

type StructureValidationError =
  | "missing_or_invalid_status"
  | "missing_or_invalid_method"
  | "missing_or_invalid_id"
  | "missing_or_invalid_organization_id"
  | "missing_or_invalid_workflow_id"
  | "missing_or_invalid_created_at"
  | "missing_or_invalid_updated_at"
  | "missing_or_invalid_retry_count"
  | "missing_or_invalid_error_reason"

type ErrorReasonValidationError = "error_reason_too_long" | "error_reason_is_empty" | "error_reason_not_defined"

export type LockValidationError =
  "lock_date_prior_creation" | "lock_by_too_long" | "lock_by_is_empty" | "lock_by_invalid_format"

export const MAX_LOCK_BY_LENGTH = 1024
export const MAX_ERROR_REASON_LENGTH = 16384

export function validateLock(lock: Lock | undefined, createdAt: Date): Either<LockValidationError, Lock | undefined> {
  if (!lock) return right(undefined)
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
): Either<ErrorReasonValidationError, string> {
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
   *   status: "ready",
   *   retryCount: 0,
   *   createdAt: new Date(),
   *   updatedAt: new Date(),
   *   occ: 123n
   * })
   * // Returns: right(validatedTask) or left(validationError)
   * ```
   */
  static validate<T extends WorkflowActionTaskDecoratorSelector>(
    dataToBeValidated: unknown
  ): Either<WorkflowActionTaskValidationError, DecoratedWorkflowActionTask<T>> {
    if (!isObject(dataToBeValidated)) return left("workflow_action_task_missing_or_invalid_status")

    const baseDataValidation = this.validateBaseTaskData(dataToBeValidated)
    if (isLeft(baseDataValidation)) return baseDataValidation

    const unvalidatedBaseData = baseDataValidation.right

    let eitherTaskData: Either<WorkflowActionTaskValidationError, WorkflowActionTaskData>

    switch (unvalidatedBaseData.status) {
      case TaskStatus.READY:
        eitherTaskData = this.validatePendingTaskData({...unvalidatedBaseData, status: TaskStatus.READY})
        break
      case TaskStatus.CLAIMED:
      case TaskStatus.EXECUTING:
      case TaskStatus.RETRY_DUE:
      case TaskStatus.UNKNOWN:
      case TaskStatus.PAUSED:
        eitherTaskData = right({...unvalidatedBaseData, status: unvalidatedBaseData.status})
        break
      case TaskStatus.SUCCEEDED:
        eitherTaskData = this.validateCompletedTaskData({...unvalidatedBaseData, status: TaskStatus.SUCCEEDED})
        break
      case TaskStatus.FAILED:
        eitherTaskData = this.validateErrorTaskData({...unvalidatedBaseData, status: TaskStatus.FAILED})
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

  private static validateBaseTaskData(
    dataToBeValidated: object
  ): Either<WorkflowActionTaskValidationError, WorkflowActionTaskBaseData> {
    if (!hasOwnProperty(dataToBeValidated, "status") || typeof dataToBeValidated.status !== "string")
      return left("workflow_action_task_missing_or_invalid_status")

    const statusValidation = validateTaskStatus(
      dataToBeValidated.status,
      "workflow_action_task_missing_or_invalid_status"
    )
    if (isLeft(statusValidation)) return statusValidation

    if (!hasOwnProperty(dataToBeValidated, "id") || typeof dataToBeValidated.id !== "string")
      return left("workflow_action_task_missing_or_invalid_id")

    if (!hasOwnProperty(dataToBeValidated, "organizationId") || !isOrganizationId(dataToBeValidated.organizationId))
      return left("workflow_action_task_missing_or_invalid_organization_id")

    if (!hasOwnProperty(dataToBeValidated, "workflowId") || typeof dataToBeValidated.workflowId !== "string")
      return left("workflow_action_task_missing_or_invalid_workflow_id")

    if (!hasOwnProperty(dataToBeValidated, "createdAt") || !isDate(dataToBeValidated.createdAt))
      return left("workflow_action_task_missing_or_invalid_created_at")

    if (!hasOwnProperty(dataToBeValidated, "updatedAt") || !isDate(dataToBeValidated.updatedAt))
      return left("workflow_action_task_missing_or_invalid_updated_at")

    if (
      !hasOwnProperty(dataToBeValidated, "retryCount") ||
      typeof dataToBeValidated.retryCount !== "number" ||
      !Number.isSafeInteger(dataToBeValidated.retryCount) ||
      dataToBeValidated.retryCount < 0
    )
      return left("workflow_action_task_missing_or_invalid_retry_count")

    return right({
      ...dataToBeValidated,
      id: dataToBeValidated.id,
      organizationId: dataToBeValidated.organizationId,
      workflowId: dataToBeValidated.workflowId,
      status: statusValidation.right,
      createdAt: dataToBeValidated.createdAt,
      updatedAt: dataToBeValidated.updatedAt,
      retryCount: dataToBeValidated.retryCount
    })
  }

  private static validatePendingTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.READY} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionPendingTaskData> {
    return right({...dataToBeValidated})
  }

  private static validateCompletedTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.SUCCEEDED} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionCompletedTaskData> {
    return right({...dataToBeValidated})
  }

  private static validateErrorTaskData(
    dataToBeValidated: WorkflowActionTaskBaseData & {status: TaskStatus.FAILED} & {[key: string]: unknown}
  ): Either<WorkflowActionTaskValidationError, WorkflowActionErrorTaskData> {
    if (!hasOwnProperty(dataToBeValidated, "errorReason") || dataToBeValidated.errorReason === undefined)
      return right({...dataToBeValidated})
    if (typeof dataToBeValidated.errorReason !== "string")
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
