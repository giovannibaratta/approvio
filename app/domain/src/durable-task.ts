import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isDate, isObject} from "@utils"

declare const _LeaseBrand: unique symbol

interface LeaseData {
  readonly owner: string
  readonly fencing: bigint
  readonly expiresAt: Date
}

export type Lease = Brand<LeaseData, typeof _LeaseBrand>
export type LeaseValidationError =
  "lease_malformed_object" | "lease_invalid_owner" | "lease_invalid_fencing" | "lease_invalid_expires_at"

export class LeaseFactory {
  static validate(data: unknown): Either<LeaseValidationError, Lease> {
    if (!isObject(data)) return left("lease_malformed_object")
    if (typeof data.owner !== "string" || !data.owner.trim()) return left("lease_invalid_owner")
    if (typeof data.fencing !== "bigint" || data.fencing < 1n) return left("lease_invalid_fencing")
    if (!isDate(data.expiresAt) || !Number.isFinite(data.expiresAt.getTime())) return left("lease_invalid_expires_at")
    return right(
      brand<LeaseData, typeof _LeaseBrand>({owner: data.owner, fencing: data.fencing, expiresAt: data.expiresAt})
    )
  }
}

export type TaskState = "ready" | "claimed" | "sending" | "succeeded" | "retry_due" | "failed" | "unknown" | "paused"

export type TaskTransitionError = "task_invalid_transition"

/**
 * Lifecycle states of a durable background work item (webhook, email, slack action, …).
 *
 * - `ready`     – scheduled and waiting to be picked up by a worker.
 * - `claimed`   – a worker holds a lease and is preparing to dispatch.
 * - `sending`   – the outbound request has been initiated; the worker owns the
 *                 network call. No other worker may claim this item.
 * - `succeeded` – the request completed with a confirmed successful outcome.
 * - `retry_due` – a transient, deterministic failure occurred (e.g. 429, 503);
 *                 the item will be reclaimed after a back-off interval.
 * - `failed`    – a permanent failure occurred (e.g. 400, 404, auth error);
 *                 no further retries will be attempted.
 * - `unknown`   – the network call was initiated but the outcome is
 *                 indeterminate (e.g. a timeout after the connection was
 *                 established). The external system may or may not have
 *                 processed the request. Retry only when the destination
 *                 honors a stable idempotency key; otherwise an operator must
 *                 resolve it. Collapsing it into `failed` would be incorrect
 *                 because the action may have already executed remotely.
 * - `paused`    – administratively held; no worker will reclaim the item until
 *                 it is resumed back to `ready`.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskState, ReadonlyArray<TaskState>>> = {
  ready: ["claimed", "paused"],
  claimed: ["ready", "sending", "retry_due", "paused"],
  sending: ["succeeded", "retry_due", "failed", "unknown"],
  succeeded: [],
  retry_due: ["claimed", "paused"],
  failed: [],
  unknown: ["claimed", "succeeded", "failed", "paused"],
  paused: ["ready"]
}

export class TaskStateMachine {
  static transition(current: TaskState, next: TaskState): Either<TaskTransitionError, TaskState> {
    return TASK_TRANSITIONS[current].some(candidate => candidate === next)
      ? right(next)
      : left("task_invalid_transition")
  }
}
