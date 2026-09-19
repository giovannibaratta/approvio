import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {InvitationFactory, OrgRole} from "@domain"

describe("invitation domain", () => {
  it("creates a pending invitation with a seven-day expiry", () => {
    // Given
    const input = {
      organizationId: randomOrgId(),
      inviteeAccountId: uuidv7(),
      inviterUserId: uuidv7(),
      orgRole: OrgRole.MEMBER
    }

    // When
    const result = InvitationFactory.create(input)

    // Expect
    const {invitation} = unwrapRight(result)
    expect(invitation.status).toBe("pending")
    expect(invitation.expiresAt.getTime() - invitation.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it("derives accepted and revoked status from transition timestamps", () => {
    // Given
    const invitation = createInvitationData()
    const transitionAt = new Date(invitation.createdAt.getTime() + 1000)

    // When
    const accepted = InvitationFactory.validate({...invitation, acceptedAt: transitionAt})
    const revoked = InvitationFactory.validate({...invitation, revokedAt: transitionAt})

    // Expect
    expect(unwrapRight(accepted)).toMatchObject({status: "accepted", acceptedAt: transitionAt})
    expect(unwrapRight(revoked)).toMatchObject({status: "revoked", revokedAt: transitionAt})
  })

  it("rejects conflicting transition timestamps", () => {
    // Given
    const invitation = createInvitationData()

    // When
    const result = InvitationFactory.validate({
      ...invitation,
      acceptedAt: invitation.createdAt,
      revokedAt: invitation.createdAt
    })

    // Expect
    expect(result).toBeLeftOf("invitation_invalid_status")
  })

  it("rejects an invalid creation timestamp", () => {
    // Given
    const invitation = createInvitationData()

    // When
    const result = InvitationFactory.validate({...invitation, createdAt: new Date("invalid")})

    // Expect
    expect(result).toBeLeftOf("invitation_invalid_created_at")
  })

  it.each(["acceptedAt", "revokedAt"] as const)("rejects an invalid $0 timestamp", timestamp => {
    // Given
    const invitation = createInvitationData()

    // When
    const result = InvitationFactory.validate({...invitation, [timestamp]: new Date("invalid")})

    // Expect
    expect(result).toBeLeftOf("invitation_invalid_transition_timestamp")
  })

  it("prevents admins from granting owner role", () => {
    expect(InvitationFactory.canGrant(OrgRole.ADMIN, OrgRole.OWNER)).toBe(false)
    expect(InvitationFactory.canGrant(OrgRole.OWNER, OrgRole.OWNER)).toBe(true)
  })
})

function createInvitationData() {
  const createdAt = new Date()
  return {
    id: uuidv7(),
    organizationId: randomOrgId(),
    inviteeAccountId: uuidv7(),
    inviterUserId: uuidv7(),
    orgRole: OrgRole.MEMBER,
    tokenHash: "invitation-token-hash",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000)
  }
}
