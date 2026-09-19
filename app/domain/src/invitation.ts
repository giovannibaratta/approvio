import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, getStringAsEnum, hasOwnProperty, isObject, isUUIDv7} from "@utils"
import {OrgRole} from "./user"
import {TenantContext} from "./shared"

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
    if (!hasOwnProperty(data, "orgRole") || typeof data.orgRole !== "string") return left("invitation_invalid_status")
    const orgRole = getStringAsEnum(data.orgRole, OrgRole)
    if (orgRole === undefined) return left("invitation_invalid_status")
    const invitationData = {
      organizationId: data.organizationId,
      id: data.id,
      inviteeAccountId: data.inviteeAccountId,
      inviterUserId: data.inviterUserId,
      orgRole,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      status: data.status
    } satisfies InvitationData
    return right(brand<InvitationData, typeof InvitationBrand>(invitationData))
  }

  static canGrant(actorRole: OrgRole, requestedRole: OrgRole): boolean {
    if (actorRole === OrgRole.OWNER) return true
    return actorRole === OrgRole.ADMIN && requestedRole !== OrgRole.OWNER
  }
}
