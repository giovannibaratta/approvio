import {toOrganizationId} from "@test/organization-id"
import {TokenPayloadBuilder, TokenPayloadValidator} from "@services/auth/auth-token"
import {Account, AccountFactory, MembershipStatus, OrgRole, User} from "@domain"
import {unwrapRight} from "@utils/either"

describe("TokenPayloadBuilder", () => {
  describe("fromUser", () => {
    const user: User = {
      id: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e60",
      organizationId: toOrganizationId("018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e64"),
      accountId: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e61",
      displayName: "Tenant user",
      status: MembershipStatus.ACTIVE,
      orgRole: OrgRole.MEMBER,
      roles: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    }
    const issuer = "https://idp.example.com"
    const audience = ["https://api.example.com"]
    const providerId = "custom"

    it("should include standard user claims", () => {
      const sessionContextVersion = 9_007_199_254_740_993n
      // When: Creating a payload from a user
      const payload = TokenPayloadBuilder.fromUser(user, {
        issuer,
        audience,
        email: "user@example.com",
        providerId,
        sessionId: user.id,
        sessionContextVersion
      })

      // Expect: Payload contains the correct basic information
      expect(payload).toMatchObject({
        iss: issuer,
        sub: user.id,
        aud: audience,
        name: user.displayName,
        entityType: "user",
        email: "user@example.com",
        orgRole: user.orgRole,
        providerId,
        sessionContextVersion: "9007199254740993"
      })
    })

    it("should preserve step-up context information when provided", () => {
      // Given: Step-up context details
      const stepUpContext = {
        jti: "test-jwt-id",
        operation: "vote" as const,
        resource: "workflow-123"
      }

      // When: Creating a payload with step-up context
      const payload = TokenPayloadBuilder.fromUser(user, {
        issuer,
        audience,
        email: "user@example.com",
        providerId,
        sessionId: user.id,
        sessionContextVersion: 0n,
        stepUpContext
      })

      // Expect: Step-up context fields are preserved in the payload
      expect(payload).toMatchObject({
        jti: stepUpContext.jti,
        operation: stepUpContext.operation,
        resource: stepUpContext.resource,
        providerId
      })
    })

    it("should not include step-up context when not provided", () => {
      // When: Creating a payload without step-up context
      const payload = TokenPayloadBuilder.fromUser(user, {
        issuer,
        audience,
        email: "user@example.com",
        providerId,
        sessionId: user.id,
        sessionContextVersion: 0n
      })

      // Expect: Optional context fields are undefined
      expect(payload.jti).toBeUndefined()
      expect(payload.operation).toBeUndefined()
      expect(payload.resource).toBeUndefined()
      expect(payload.providerId).toBe(providerId)
    })

    it("requires the account email and organization role claims", () => {
      const payload = TokenPayloadBuilder.fromUser(user, {
        issuer,
        audience,
        email: "user@example.com",
        providerId,
        sessionId: user.id,
        sessionContextVersion: 0n
      })
      const claims = {...payload, exp: 1_800_000_000, iat: 1_700_000_000}

      expect(TokenPayloadValidator.isValidPayloadSchema(claims)).toBe(true)
      expect(TokenPayloadValidator.isValidPayloadSchema({...claims, email: undefined})).toBe(false)
      expect(TokenPayloadValidator.isValidPayloadSchema({...claims, orgRole: undefined})).toBe(false)
    })
  })

  describe("fromPlatformAccount", () => {
    const account: Account = unwrapRight(
      AccountFactory.validate({
        id: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e61",
        displayName: "Platform account",
        profileEmail: "user@example.com",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      })
    )

    it("binds the account credential to its browser session and configured provider", () => {
      const payload = TokenPayloadBuilder.fromPlatformAccount(account, {
        issuer: "https://api.example.com",
        audience: ["https://api.example.com"],
        sessionId: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e62",
        providerId: "custom",
        sessionContextVersion: 0n
      })

      expect(payload).toMatchObject({
        entityType: "platform",
        sub: account.id,
        sessionId: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e62",
        providerId: "custom",
        sessionContextVersion: "0"
      })
    })

    it("rejects a platform credential without a numeric context version", () => {
      const payload = {
        ...TokenPayloadBuilder.fromPlatformAccount(account, {
          issuer: "https://api.example.com",
          audience: ["https://api.example.com"],
          sessionId: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e62",
          providerId: "custom",
          sessionContextVersion: 0n
        }),
        exp: 1_800_000_000,
        iat: 1_700_000_000,
        sessionContextVersion: "invalid"
      }

      expect(TokenPayloadValidator.isValidPayloadSchema(payload)).toBe(false)
    })
  })
})
