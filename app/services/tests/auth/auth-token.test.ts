import {TokenPayloadBuilder} from "@services/auth/auth-token"
import {createMockUserDomain} from "@test/mock-data"

describe("TokenPayloadBuilder", () => {
  describe("fromUser", () => {
    const user = createMockUserDomain()
    const issuer = "https://idp.example.com"
    const audience = ["https://api.example.com"]

    it("should include standard user claims", () => {
      // When: Creating a payload from a user
      const payload = TokenPayloadBuilder.fromUser(user, {issuer, audience})

      // Expect: Payload contains the correct basic information
      expect(payload).toMatchObject({
        iss: issuer,
        sub: user.id,
        aud: audience,
        email: user.email,
        name: user.displayName,
        entityType: "user",
        orgRole: user.orgRole
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
        stepUpContext
      })

      // Expect: Step-up context fields are preserved in the payload
      expect(payload).toMatchObject({
        jti: stepUpContext.jti,
        operation: stepUpContext.operation,
        resource: stepUpContext.resource
      })
    })

    it("should not include step-up context when not provided", () => {
      // When: Creating a payload without step-up context
      const payload = TokenPayloadBuilder.fromUser(user, {issuer, audience})

      // Expect: Optional context fields are undefined
      expect(payload.jti).toBeUndefined()
      expect(payload.operation).toBeUndefined()
      expect(payload.resource).toBeUndefined()
    })
  })
})
