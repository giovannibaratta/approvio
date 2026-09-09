import {Either, left, right} from "fp-ts/Either"
import {isUUIDv7} from "@utils"
import {Actor, StepUpOperation} from "./authenticated-entity"
import {OrgRole} from "./user"
import {TenantContext} from "./shared"

/**
 * A platform-authentication session. It may select one organization for browser
 * navigation, but it is not itself tenant authority.
 */
export interface Session {
  readonly id: string
  readonly accountId: string
  readonly providerConnectionId: string
  /** Null until the account deliberately selects an organization. */
  readonly selectedOrganizationId: string | null
  // TODO: Who the contextVersion differs from teh occ ?
  /** Changes whenever the selected browser organization changes. */
  readonly contextVersion: bigint
  // TODO: We have the versioned type for this
  /** Optimistic-concurrency version for session mutations. */
  readonly occ: bigint
  readonly transport: "browser" | "cli"
  readonly expiresAt: Date
}

// TODO: Is the accountId the inviter or the being invited ?
export interface Invitation extends TenantContext {
  readonly id: string
  readonly accountId: string
  readonly inviterUserId: string
  readonly orgRole: OrgRole
  readonly tokenHash: string
  readonly expiresAt: Date
  readonly status: "pending" | "accepted" | "revoked"
}

export type InvitationValidationError =
  | "invitation_invalid_organization_id"
  | "invitation_invalid_id"
  | "invitation_invalid_account_id"
  | "invitation_invalid_inviter_id"
  | "invitation_invalid_token_hash"
  | "invitation_expiry_required"
  | "invitation_invalid_status"

  // TODO: Document the rationale being this method.
  static canGrant(actorRole: OrgRole, requestedRole: OrgRole): boolean {
    if (actorRole === OrgRole.OWNER) return true
    return actorRole === OrgRole.ADMIN && requestedRole !== OrgRole.OWNER
// TODO: This doesn't seems to be the right file to define the events. Even the SetpUpReceipt
