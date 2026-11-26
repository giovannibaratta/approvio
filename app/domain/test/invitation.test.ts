import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {createMockAccountDomain, createMockUserDomain} from "@test/mock-data"
import {InvitationFactory, OrgRole, UserFactory} from "@domain"

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

  it("returns an expiry error to the intended invitee with a valid token", () => {
    // Given
    const {invitation, token, account, inviter} = createAcceptanceFixture()
    const expired = unwrapRight(InvitationFactory.validate({...invitation, expiresAt: new Date(0)}))

    // When
    const result = InvitationFactory.accept(expired, account, inviter, token)

    // Expect
    expect(result).toBeLeftOf("invitation_expired")
  })

  it("returns a revocation error to the intended invitee with a valid token", () => {
    // Given
    const {invitation, token, account, inviter} = createAcceptanceFixture()
    const revoked = unwrapRight(InvitationFactory.validate({...invitation, revokedAt: new Date()}))

    // When
    const result = InvitationFactory.accept(revoked, account, inviter, token)

    // Expect
    expect(result).toBeLeftOf("invitation_revoked")
  })

  it("returns an already-accepted error to the intended invitee with a valid token", () => {
    // Given
    const {invitation, token, account, inviter} = createAcceptanceFixture()
    const accepted = unwrapRight(InvitationFactory.accept(invitation, account, inviter, token))

    // When
    const result = InvitationFactory.accept(accepted, account, inviter, token)

    // Expect
    expect(result).toBeLeftOf("invitation_already_accepted")
  })

  it("reports when the inviter can no longer grant the requested role", () => {
    // Given
    const {invitation, token, account, inviter} = createAcceptanceFixture(OrgRole.OWNER)
    const demoted = unwrapRight(UserFactory.validate({...inviter, orgRole: OrgRole.ADMIN}))

    // When
    const result = InvitationFactory.accept(invitation, account, demoted, token)

    // Expect
    expect(result).toBeLeftOf("invitation_grant_no_longer_allowed")
  })

  it("checks the token before exposing expiry", () => {
    // Given
    const {invitation, account, inviter} = createAcceptanceFixture()
    const expired = unwrapRight(InvitationFactory.validate({...invitation, expiresAt: new Date(0)}))

    // When
    const result = InvitationFactory.accept(expired, account, inviter, "incorrect-token")

    // Expect
    expect(result).toBeLeftOf("invitation_invalid")
  })

  it("checks the intended account before exposing revocation", () => {
    // Given
    const {invitation, token, inviter} = createAcceptanceFixture()
    const revoked = unwrapRight(InvitationFactory.validate({...invitation, revokedAt: new Date()}))
    const other = createMockAccountDomain()

    // When
    const result = InvitationFactory.accept(revoked, other, inviter, token)

    // Expect
    expect(result).toBeLeftOf("invitation_invalid")
  })
  it("reports an already revoked invitation to an authorized manager", () => {
    // Given
    const {invitation, inviter} = createAcceptanceFixture()
    const revoked = unwrapRight(InvitationFactory.revoke(invitation, inviter))

    // When
    const result = InvitationFactory.revoke(revoked, inviter)

    // Expect: repeated revocation identifies the existing state.
    expect(result).toBeLeftOf("invitation_revoked")
  })

  it("does not reveal revocation to a manager from another organization", () => {
    // Given
    const {invitation, inviter} = createAcceptanceFixture()
    const revoked = unwrapRight(InvitationFactory.revoke(invitation, inviter))
    const other = createMockUserDomain({orgRole: OrgRole.OWNER})

    // When
    const result = InvitationFactory.revoke(revoked, other)

    // Expect: authorization is checked before disclosing the invitation's state.
    expect(result).toBeLeftOf("invitation_invalid")
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

function createAcceptanceFixture(orgRole = OrgRole.MEMBER) {
  const account = createMockAccountDomain()
  const inviter = createMockUserDomain({orgRole: OrgRole.OWNER})
  const created = unwrapRight(
    InvitationFactory.create({
      organizationId: inviter.organizationId,
      inviteeAccountId: account.id,
      inviterUserId: inviter.id,
      orgRole
    })
  )
  return {...created, account, inviter}
}
