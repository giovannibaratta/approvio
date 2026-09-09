// TODO: This file is overloaded. Resolve the other TODOs first before moving stuff around.
import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, hasOwnProperty, isObject, isUUIDv7} from "@utils"
import {StepUpOperation} from "./authenticated-entity"
import {OrgRole} from "./user"
import {TenantContext, Versioned} from "./shared"

/**
 * A platform-authentication session. It may select one organization for browser
 * navigation, but it is not itself tenant authority.
 */
interface SessionData {
  readonly id: string
  readonly accountId: string
  readonly providerConnectionId: string
  /** Null until the account deliberately selects an organization. */
  readonly selectedOrganizationId: string | null
  /** Changes whenever the selected browser organization changes. */
  readonly contextVersion: bigint
  /** Optimistic-concurrency version for session mutations. */
  readonly transport: "browser" | "cli"
  readonly expiresAt: Date
}

export type Session = Versioned<SessionData>

interface InvitationData extends TenantContext {
  readonly id: string
  readonly inviteeAccountId: string
  readonly inviterUserId: string
  readonly orgRole: OrgRole
  readonly tokenHash: string
  readonly expiresAt: Date
  readonly status: "pending" | "accepted" | "revoked"
}

declare const InvitationBrand: unique symbol
export type Invitation = Brand<InvitationData, typeof InvitationBrand>

export type InvitationValidationError =
  | "invitation_invalid_organization_id"
  | "invitation_invalid_id"
  | "invitation_invalid_account_id"
  | "invitation_invalid_inviter_id"
  | "invitation_invalid_token_hash"
  | "invitation_expiry_required"
  | "invitation_invalid_status"

export class InvitationFactory {
  static validate(data: unknown): Either<InvitationValidationError, Invitation> {
    if (!isObject(data)) return left("invitation_invalid_organization_id")
    if (
      !hasOwnProperty(data, "organizationId") ||
      typeof data.organizationId !== "string" ||
      !isUUIDv7(data.organizationId)
    )
      return left("invitation_invalid_organization_id")
    if (!hasOwnProperty(data, "id") || typeof data.id !== "string" || !isUUIDv7(data.id))
      return left("invitation_invalid_id")
    if (
      !hasOwnProperty(data, "inviteeAccountId") ||
      typeof data.inviteeAccountId !== "string" ||
      !isUUIDv7(data.inviteeAccountId)
    )
      return left("invitation_invalid_account_id")
    if (
      !hasOwnProperty(data, "inviterUserId") ||
      typeof data.inviterUserId !== "string" ||
      !isUUIDv7(data.inviterUserId)
    )
      return left("invitation_invalid_inviter_id")
    if (!hasOwnProperty(data, "tokenHash") || typeof data.tokenHash !== "string" || !data.tokenHash.trim())
      return left("invitation_invalid_token_hash")
    if (
      !hasOwnProperty(data, "expiresAt") ||
      !(data.expiresAt instanceof Date) ||
      Number.isNaN(data.expiresAt.getTime())
    )
      return left("invitation_expiry_required")
    if (
      !hasOwnProperty(data, "status") ||
      (data.status !== "pending" && data.status !== "accepted" && data.status !== "revoked")
    )
      return left("invitation_invalid_status")
    if (!hasOwnProperty(data, "orgRole") || !Object.values(OrgRole).includes(data.orgRole as OrgRole))
      return left("invitation_invalid_status")
    // TODO: Remove casting use satisfy
    return right(brand<InvitationData, typeof InvitationBrand>(data as InvitationData))
  }

  static canGrant(actorRole: OrgRole, requestedRole: OrgRole): boolean {
    if (actorRole === OrgRole.OWNER) return true
    return actorRole === OrgRole.ADMIN && requestedRole !== OrgRole.OWNER
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
 *                 processed the request. `unknown` is therefore not terminal:
 *                 the worker can retry via `claimed` using an idempotency key,
 *                 or an operator can force-resolve to `succeeded` / `failed`.
 *                 Collapsing it into `failed` would be incorrect because the
 *                 action may have already executed on the remote side.
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
