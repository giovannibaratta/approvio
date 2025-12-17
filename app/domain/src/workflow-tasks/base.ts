import {Either, left, right} from "fp-ts/lib/Either"
import {PrefixUnion, getStringAsEnum} from "@utils"

export enum TaskStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR"
}

export interface WorkflowActionTaskData {
  id: string
  workflowId: string
  status: TaskStatus
  retryCount: number
  errorReason?: string
  createdAt: Date
  updatedAt: Date
}

export type Lock = {
  lockedBy: string
  lockedAt: Date
}

export type WorkflowActionTaskValidationError = PrefixUnion<
  "workflow_action_task",
  UnprefixedWorkflowActionTaskValidationError
>

type UnprefixedWorkflowActionTaskValidationError = LockValidationError

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

export function validateErrorReason<E extends string>(
  errorReason: string | undefined,
  errorReasonTooLongError: E
): Either<E, void> {
  if (errorReason && errorReason.length > MAX_ERROR_REASON_LENGTH) return left(errorReasonTooLongError)
  return right(undefined)
}

export function mapLockErrorWithPrefix<E extends string>(error: LockValidationError, prefix: string): Either<E, never> {
  return left(`${prefix}_${error}` as E)
}
