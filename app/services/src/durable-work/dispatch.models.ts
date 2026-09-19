import {Lease, TaskKind} from "@domain"
import {Brand, brand, getStringAsEnum, isObject, isUUIDv7, isUUIDv5} from "@utils"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {DispatchCompletion} from "./models"

export enum DispatchWorkState {
  READY = "ready",
  RETRY_DUE = "retry_due",
  CLAIMED = "claimed",
  EXECUTING = "executing",
  PAUSED = "paused",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  UNKNOWN = "unknown"
}

export enum DispatchAttemptState {
  ADMITTED = "admitted",
  EXECUTING = "executing",
  SUCCEEDED = "succeeded",
  RETRY_DUE = "retry_due",
  FAILED = "failed",
  UNKNOWN = "unknown"
}

type WorkState = `${DispatchWorkState}`

declare const _Work: unique symbol
declare const _Attempt: unique symbol

interface WorkData {
  readonly id: string
  readonly kind: TaskKind
  readonly state: WorkState
  readonly fencing: bigint
  readonly occ: bigint
  readonly attempts: number
  readonly lease?: {readonly owner: string; readonly expiresAt: Date}
}
/**
 * Durable delivery state of the entire task, shared by all its internal attempts.
 * Its id is the stable task ID. retry_due means another attempt may be claimed;
 * it does not mean the task's unit of work has completed.
 */
export type DispatchWork = Brand<WorkData, typeof _Work>

interface AttemptBaseData {
  readonly id: string
  readonly taskId: string
  readonly fencing: bigint
  readonly occ: bigint
  readonly admittedAt: Date
}

type AttemptData = AttemptBaseData &
  (
    | {readonly state: "admitted"}
    | {readonly state: "executing"; readonly executingAt: Date}
    | {
        readonly state: "failed"
        readonly executingAt?: Date
        readonly completedAt: Date
        readonly outcomeCategory: string
      }
    | {
        readonly state: "succeeded" | "retry_due" | "unknown"
        readonly executingAt: Date
        readonly completedAt: Date
        readonly outcomeCategory: string
      }
  )

/**
 * Persisted state of one internal execution attempt. Its id identifies this
 * attempt, while taskId identifies the task whose work it executes. A completed
 * attempt may have state retry_due: that attempt is closed and a future claim
 * creates a new attempt for the same task.
 */
export type DispatchAttempt = Brand<AttemptData, typeof _Attempt>

export type DispatchWorkValidationError =
  | "dispatch_work_malformed_object"
  | "dispatch_work_invalid_id"
  | "dispatch_work_invalid_kind"
  | "dispatch_work_invalid_state"
  | "dispatch_work_invalid_fencing"
  | "dispatch_work_invalid_occ"
  | "dispatch_work_invalid_attempts"
  | "dispatch_work_invalid_lease_owner"
  | "dispatch_work_invalid_lease_until"
  | "dispatch_work_invalid_lease"

export type DispatchAttemptValidationError =
  | "dispatch_attempt_malformed_object"
  | "dispatch_attempt_invalid_id"
  | "dispatch_attempt_invalid_task_id"
  | "dispatch_attempt_invalid_state"
  | "dispatch_attempt_invalid_fencing"
  | "dispatch_attempt_invalid_occ"
  | "dispatch_attempt_invalid_admitted_at"
  | "dispatch_attempt_invalid_executing_at"
  | "dispatch_attempt_invalid_completed_at"
  | "dispatch_attempt_invalid_outcome_category"

export class DispatchWorkFactory {
  static validate(data: unknown): E.Either<DispatchWorkValidationError, DispatchWork> {
    if (!isObject(data)) return E.left("dispatch_work_malformed_object")
    if (typeof data.id !== "string" || (!isUUIDv7(data.id) && !isUUIDv5(data.id)))
      return E.left("dispatch_work_invalid_id")
    if (data.kind !== "email" && data.kind !== "slack" && data.kind !== "webhook")
      return E.left("dispatch_work_invalid_kind")
    const state = typeof data.state === "string" ? getStringAsEnum(data.state, DispatchWorkState) : undefined
    if (state === undefined) return E.left("dispatch_work_invalid_state")
    if (typeof data.fencing !== "bigint") return E.left("dispatch_work_invalid_fencing")
    if (typeof data.occ !== "bigint") return E.left("dispatch_work_invalid_occ")
    if (typeof data.attempts !== "number" || !Number.isInteger(data.attempts))
      return E.left("dispatch_work_invalid_attempts")
    let lease: WorkData["lease"]
    if (data.lease !== undefined) {
      if (!isObject(data.lease)) return E.left("dispatch_work_invalid_lease")
      if (typeof data.lease.owner !== "string") return E.left("dispatch_work_invalid_lease_owner")
      if (!(data.lease.expiresAt instanceof Date)) return E.left("dispatch_work_invalid_lease_until")
      lease = {owner: data.lease.owner, expiresAt: data.lease.expiresAt}
    }
    return E.right(
      brand<WorkData, typeof _Work>({
        id: data.id,
        kind: data.kind,
        state,
        fencing: data.fencing,
        occ: data.occ,
        attempts: data.attempts,
        lease
      })
    )
  }
}

export class DispatchAttemptFactory {
  static validate(data: unknown): E.Either<DispatchAttemptValidationError, DispatchAttempt> {
    if (!isObject(data)) return E.left("dispatch_attempt_malformed_object")
    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return E.left("dispatch_attempt_invalid_id")
    if (typeof data.taskId !== "string" || (!isUUIDv7(data.taskId) && !isUUIDv5(data.taskId)))
      return E.left("dispatch_attempt_invalid_task_id")
    const state = typeof data.state === "string" ? getStringAsEnum(data.state, DispatchAttemptState) : undefined
    if (state === undefined) return E.left("dispatch_attempt_invalid_state")
    if (typeof data.fencing !== "bigint") return E.left("dispatch_attempt_invalid_fencing")
    if (typeof data.occ !== "bigint") return E.left("dispatch_attempt_invalid_occ")
    if (!(data.admittedAt instanceof Date)) return E.left("dispatch_attempt_invalid_admitted_at")
    const base: AttemptBaseData = {
      id: data.id,
      taskId: data.taskId,
      fencing: data.fencing,
      occ: data.occ,
      admittedAt: data.admittedAt
    }
    return validateAttemptState(data, base, state)
  }
}

function validateAttemptState(
  data: Record<string, unknown>,
  base: AttemptBaseData,
  state: DispatchAttemptState
): E.Either<DispatchAttemptValidationError, DispatchAttempt> {
  if (state === DispatchAttemptState.ADMITTED) {
    if (data.executingAt !== undefined) return E.left("dispatch_attempt_invalid_executing_at")
    if (data.completedAt !== undefined) return E.left("dispatch_attempt_invalid_completed_at")
    if (data.outcomeCategory !== undefined) return E.left("dispatch_attempt_invalid_outcome_category")
    return E.right(brand<AttemptData, typeof _Attempt>({...base, state}))
  }
  if (state === DispatchAttemptState.EXECUTING) {
    if (!(data.executingAt instanceof Date)) return E.left("dispatch_attempt_invalid_executing_at")
    if (data.completedAt !== undefined) return E.left("dispatch_attempt_invalid_completed_at")
    if (data.outcomeCategory !== undefined) return E.left("dispatch_attempt_invalid_outcome_category")
    return E.right(brand<AttemptData, typeof _Attempt>({...base, state, executingAt: data.executingAt}))
  }
  if (state === DispatchAttemptState.FAILED) {
    if (data.executingAt !== undefined && !(data.executingAt instanceof Date))
      return E.left("dispatch_attempt_invalid_executing_at")
    if (!(data.completedAt instanceof Date)) return E.left("dispatch_attempt_invalid_completed_at")
    if (typeof data.outcomeCategory !== "string") return E.left("dispatch_attempt_invalid_outcome_category")
    return E.right(
      brand<AttemptData, typeof _Attempt>({
        ...base,
        state,
        completedAt: data.completedAt,
        outcomeCategory: data.outcomeCategory,
        ...(data.executingAt === undefined ? {} : {executingAt: data.executingAt})
      })
    )
  }
  if (!(data.executingAt instanceof Date)) return E.left("dispatch_attempt_invalid_executing_at")
  if (!(data.completedAt instanceof Date)) return E.left("dispatch_attempt_invalid_completed_at")
  if (typeof data.outcomeCategory !== "string") return E.left("dispatch_attempt_invalid_outcome_category")
  return E.right(
    brand<AttemptData, typeof _Attempt>({
      ...base,
      state,
      executingAt: data.executingAt,
      completedAt: data.completedAt,
      outcomeCategory: data.outcomeCategory
    })
  )
}

/**
 * Resulting work model and the single attempt involved in this transition.
 */
export interface DispatchTransitionResult {
  readonly work: DispatchWork
  readonly attempt?: DispatchAttempt
}

export type DispatchTransitionError =
  | DispatchWorkValidationError
  | DispatchAttemptValidationError
  | "lease_lost"
  | "lease_invalid_owner"
  | "dispatch_invalid_source_state"
  | "dispatch_attempt_mismatch"
  | "dispatch_invalid_attempt_state"
  | "dispatch_invalid_completion"
  | "dispatch_lease_not_expired"

function hasValidAttemptLease(work: DispatchWork, attempt: DispatchAttempt, lease: Lease, evaluateAt: Date): boolean {
  return (
    attempt.taskId === work.id &&
    attempt.fencing === work.fencing &&
    lease.fencing === work.fencing &&
    lease.owner === work.lease?.owner &&
    work.lease !== undefined &&
    work.lease.expiresAt >= evaluateAt
  )
}

function updateWork(
  work: DispatchWork,
  changes: Partial<WorkData>
): E.Either<DispatchWorkValidationError, DispatchWork> {
  return DispatchWorkFactory.validate({...work, ...changes, occ: work.occ + 1n})
}

function completeAttempt(
  attempt: Extract<DispatchAttempt, {state: "admitted" | "executing"}>,
  state: DispatchCompletion["state"],
  completedAt: Date,
  outcomeCategory: string
): E.Either<DispatchAttemptValidationError, DispatchAttempt> {
  return DispatchAttemptFactory.validate({...attempt, state, completedAt, outcomeCategory, occ: attempt.occ + 1n})
}

export class DispatchTransitionFactory {
  static claim(
    work: DispatchWork,
    owner: string,
    evaluateAt: Date,
    expiresAt: Date,
    attemptId: string
  ): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    if (!owner.trim()) return E.left("lease_invalid_owner")
    // Unknown delivery is retryable only when the webhook uses its immutable task ID for deduplication.
    if (!(
      work.state === "ready" ||
      work.state === "retry_due" ||
      (work.state === "unknown" && work.kind === "webhook")
    ))
      return E.left("dispatch_invalid_source_state")
    if (work.lease !== undefined && work.lease.expiresAt >= evaluateAt) return E.left("lease_lost")

    return pipe(
      updateWork(work, {
        state: "claimed",
        lease: {owner, expiresAt},
        fencing: work.fencing + 1n,
        attempts: work.attempts + 1
      }),
      E.bindTo("work"),
      E.bindW("attempt", () =>
        DispatchAttemptFactory.validate({
          id: attemptId,
          taskId: work.id,
          state: "admitted",
          fencing: work.fencing + 1n,
          occ: 0n,
          admittedAt: evaluateAt
        })
      )
    )
  }

  static recover(
    work: DispatchWork,
    attempt: DispatchAttempt,
    evaluateAt: Date
  ): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    if (work.state !== "claimed" && work.state !== "executing") return E.left("dispatch_invalid_source_state")
    if (work.lease === undefined) return E.left("lease_lost")
    if (work.lease.expiresAt >= evaluateAt) return E.left("dispatch_lease_not_expired")
    const executing = work.state === "executing"
    if (attempt.taskId !== work.id || attempt.fencing !== work.fencing) return E.left("dispatch_attempt_mismatch")
    if (attempt.state !== "admitted" && attempt.state !== "executing") return E.left("dispatch_invalid_attempt_state")
    if (attempt.state !== (executing ? "executing" : "admitted")) return E.left("dispatch_invalid_attempt_state")

    return pipe(
      updateWork(work, {
        state: executing ? "unknown" : "retry_due",
        lease: undefined,
        fencing: work.fencing + 1n
      }),
      E.bindTo("work"),
      E.bindW("attempt", () => completeAttempt(attempt, executing ? "unknown" : "failed", evaluateAt, "lease_expired"))
    )
  }

  static pauseReady(work: DispatchWork): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    const evaluateAt = new Date()
    if (work.state !== "ready" && work.state !== "retry_due") return E.left("dispatch_invalid_source_state")
    if (work.lease !== undefined && work.lease.expiresAt >= evaluateAt) return E.left("lease_lost")
    return pipe(updateWork(work, {state: "paused", lease: undefined}), E.bindTo("work"))
  }

  static pauseAttempt(
    work: DispatchWork,
    attempt: DispatchAttempt,
    lease: Lease
  ): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    const evaluateAt = new Date()
    if (attempt.taskId !== work.id) return E.left("dispatch_attempt_mismatch")
    if (!hasValidAttemptLease(work, attempt, lease, evaluateAt)) return E.left("lease_lost")
    if (work.state !== "claimed") return E.left("dispatch_invalid_source_state")
    if (attempt.state !== "admitted") return E.left("dispatch_invalid_attempt_state")
    return pipe(
      updateWork(work, {state: "paused", lease: undefined}),
      E.bindTo("work"),
      E.bindW("attempt", () => completeAttempt(attempt, "failed", evaluateAt, "organization_paused"))
    )
  }

  static validateAttemptLease(
    work: DispatchWork,
    attempt: DispatchAttempt,
    lease: Lease
  ): E.Either<DispatchTransitionError, void> {
    const evaluateAt = new Date()
    if (attempt.taskId !== work.id) return E.left("dispatch_attempt_mismatch")
    return hasValidAttemptLease(work, attempt, lease, evaluateAt) ? E.right(undefined) : E.left("lease_lost")
  }

  static startExecution(
    work: DispatchWork,
    attempt: DispatchAttempt,
    lease: Lease
  ): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    const evaluateAt = new Date()
    if (attempt.taskId !== work.id) return E.left("dispatch_attempt_mismatch")
    if (!hasValidAttemptLease(work, attempt, lease, evaluateAt)) return E.left("lease_lost")
    if (work.state !== "claimed") return E.left("dispatch_invalid_source_state")
    if (attempt.state !== "admitted") return E.left("dispatch_invalid_attempt_state")
    return pipe(
      updateWork(work, {state: "executing"}),
      E.bindTo("work"),
      E.bindW("attempt", () =>
        DispatchAttemptFactory.validate({
          ...attempt,
          state: "executing",
          executingAt: evaluateAt,
          occ: attempt.occ + 1n
        })
      )
    )
  }

  static complete(
    work: DispatchWork,
    attempt: DispatchAttempt,
    lease: Lease,
    completion: DispatchCompletion
  ): E.Either<DispatchTransitionError, DispatchTransitionResult> {
    const evaluateAt = new Date()
    if (attempt.taskId !== work.id) return E.left("dispatch_attempt_mismatch")
    if (!hasValidAttemptLease(work, attempt, lease, evaluateAt)) return E.left("lease_lost")
    if (attempt.state !== "admitted" && attempt.state !== "executing") return E.left("dispatch_invalid_attempt_state")
    let nextWorkState: WorkState = completion.state
    if (attempt.state === "admitted") {
      if (work.state !== "claimed") return E.left("dispatch_invalid_source_state")
      if (completion.state !== "failed") return E.left("dispatch_invalid_completion")
      // Execution never started: close the failed attempt and allow the task to retry.
      nextWorkState = "retry_due"
    } else if (work.state !== "executing") return E.left("dispatch_invalid_source_state")

    return pipe(
      updateWork(work, {state: nextWorkState, lease: undefined}),
      E.bindTo("work"),
      E.bindW("attempt", () =>
        completeAttempt(attempt, completion.state, evaluateAt, outcomeCategory(completion.outcome))
      )
    )
  }
}

function outcomeCategory(outcome: DispatchCompletion["outcome"]): string {
  switch (outcome.type) {
    case "delivered":
      return "delivered"
    case "http_response":
      return `http_${outcome.statusCode}`
    case "task_load_failed":
    case "delivery_error":
      return outcome.error
  }
}
