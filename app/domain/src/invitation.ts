import {createHash, randomBytes, timingSafeEqual} from "node:crypto"
import {Either, left, right, map} from "fp-ts/Either"
import {Brand, brand, getStringAsEnum, hasOwnProperty, isObject, isUUIDv7} from "@utils"
import {OrgRole, User, MembershipStatus} from "./user"
import {Account} from "./account"
import {v7 as uuidv7} from "uuid"
import {TenantContext, isOrganizationId} from "./shared"

interface InvitationBaseData extends TenantContext {
  readonly id: string
  readonly inviteeAccountId: string
  readonly inviterUserId: string
  readonly orgRole: OrgRole
  readonly tokenHash: string
  readonly expiresAt: Date
}

type InvitationData = InvitationBaseData &
  (
    | {readonly status: "pending"}
    | {readonly status: "accepted"; readonly acceptedAt: Date}
    | {readonly status: "revoked"; readonly revokedAt: Date}
  )

declare const _InvitationBrand: unique symbol
export type Invitation = Brand<InvitationData, typeof _InvitationBrand>

export type InvitationValidationError =
  | "invitation_invalid_organization_id"
  | "invitation_invalid_id"
  | "invitation_invalid_account_id"
  | "invitation_invalid_inviter_id"
  | "invitation_invalid_token_hash"
  | "invitation_expiry_required"
  | "invitation_invalid_status"
  | "invitation_invalid_transition_timestamp"

export class InvitationFactory {
  static create(input: {
    readonly organizationId: TenantContext["organizationId"]
    readonly inviteeAccountId: string
    readonly inviterUserId: string
    readonly orgRole: OrgRole
  }): Either<InvitationValidationError, {readonly invitation: Invitation; readonly token: string}> {
    const token = randomBytes(32).toString("base64url")
    return map((invitation: Invitation) => ({invitation, token}))(
      InvitationFactory.validate({
        ...input,
        tokenHash: hashToken(token),
        id: uuidv7(),
        status: "pending",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      })
    )
  }

  static accept(
    invitation: Invitation,
    account: Account,
    inviter: User,
    token: string
  ): Either<"invitation_invalid" | InvitationValidationError, Invitation> {
    const now = new Date()
    if (
      invitation.status !== "pending" ||
      invitation.expiresAt <= now ||
      account.status !== "active" ||
      invitation.inviteeAccountId !== account.id ||
      !token ||
      token.length > 512 ||
      !safeTokenMatch(invitation.tokenHash, token) ||
      inviter.id !== invitation.inviterUserId ||
      inviter.organizationId !== invitation.organizationId ||
      inviter.status !== MembershipStatus.ACTIVE ||
      !InvitationFactory.canGrant(inviter.orgRole, invitation.orgRole)
    )
      return left("invitation_invalid")
    return InvitationFactory.validate({...invitation, status: "accepted", acceptedAt: now})
  }

  static revoke(
    invitation: Invitation,
    actor: User
  ): Either<"invitation_invalid" | InvitationValidationError, Invitation> {
    if (
      invitation.status !== "pending" ||
      actor.organizationId !== invitation.organizationId ||
      actor.status !== MembershipStatus.ACTIVE ||
      !InvitationFactory.canGrant(actor.orgRole, invitation.orgRole)
    )
      return left("invitation_invalid")
    return InvitationFactory.validate({...invitation, status: "revoked", revokedAt: new Date()})
  }

  static validate(data: unknown): Either<InvitationValidationError, Invitation> {
    if (!isObject(data)) return left("invitation_invalid_organization_id")
    if (!hasOwnProperty(data, "organizationId") || !isOrganizationId(data.organizationId))
      return left("invitation_invalid_organization_id")
    if (!hasUuidProperty(data, "id")) return left("invitation_invalid_id")
    if (!hasUuidProperty(data, "inviteeAccountId")) return left("invitation_invalid_account_id")
    if (!hasUuidProperty(data, "inviterUserId")) return left("invitation_invalid_inviter_id")
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
      expiresAt: data.expiresAt
    }
    return InvitationFactory.validateState(invitationData, data)
  }

  private static validateState(
    invitationData: InvitationBaseData,
    data: Record<string, unknown>
  ): Either<InvitationValidationError, Invitation> {
    if (data.status === "accepted") {
      if (!(data.acceptedAt instanceof Date) || Number.isNaN(data.acceptedAt.getTime()))
        return left("invitation_invalid_transition_timestamp")
      return right(
        brand<InvitationData, typeof _InvitationBrand>({
          ...invitationData,
          status: "accepted",
          acceptedAt: data.acceptedAt
        })
      )
    }
    if (data.status === "revoked") {
      if (!(data.revokedAt instanceof Date) || Number.isNaN(data.revokedAt.getTime()))
        return left("invitation_invalid_transition_timestamp")
      return right(
        brand<InvitationData, typeof _InvitationBrand>({
          ...invitationData,
          status: "revoked",
          revokedAt: data.revokedAt
        })
      )
    }
    return right(brand<InvitationData, typeof _InvitationBrand>({...invitationData, status: "pending"}))
  }

  static canGrant(actorRole: OrgRole, requestedRole: OrgRole): boolean {
    if (actorRole === OrgRole.OWNER) return true
    return actorRole === OrgRole.ADMIN && requestedRole !== OrgRole.OWNER
  }
}

function hasUuidProperty<K extends string>(
  data: Record<string, unknown>,
  key: K
): data is Record<string, unknown> & Record<K, string> {
  return hasOwnProperty(data, key) && typeof data[key] === "string" && isUUIDv7(data[key])
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function safeTokenMatch(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex")
  const actual = Buffer.from(hashToken(token), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
