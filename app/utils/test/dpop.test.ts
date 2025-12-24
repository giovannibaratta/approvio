import {DPOP_MAX_AGE_SECONDS, validateDpopJwt} from "@utils/dpop"
import * as jose from "jose"

describe("validateDpopJwt", () => {
  let testAgentKeyPair: jose.GenerateKeyPairResult
  let testAgentPublicKeyPem: string

  const validPayload = {
    jti: "unique-jti-123",
    htm: "POST",
    htu: "https://api.example.com/token"
  }

  beforeAll(async () => {
    // Generate test RSA key pair for signing
    testAgentKeyPair = await jose.generateKeyPair("RS256")
    testAgentPublicKeyPem = await jose.exportSPKI(testAgentKeyPair.publicKey)
  })

  const createDpopJwt = async (
    payload: jose.JWTPayload,
    headerOverride?: jose.JWTHeaderParameters
  ): Promise<string> => {
    const jwk = await jose.exportJWK(testAgentKeyPair.publicKey)
    const sign = new jose.SignJWT(payload).setProtectedHeader(
      headerOverride || {
        alg: "RS256",
        typ: "dpop+jwt",
        jwk: jwk
      }
    )

    if (!payload.iat) sign.setIssuedAt()

    return sign.sign(testAgentKeyPair.privateKey)
  }

  describe("Good Cases", () => {
    it("should validate a valid DPoP JWT", async () => {
      // Given: Valid DPoP JWT with matching method and URL
      const dpopJwt = await createDpopJwt(validPayload)
      const expectedMethod = "POST"
      const expectedUrl = "https://api.example.com/token"

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {expectedMethod, expectedUrl})()

      // Expect: Validation passes
      expect(result).toBeRight()
    })

    it("should handle URLs with query parameters and fragments correctly", async () => {
      // Given: DPoP payload with clean URL, expected URL with query/fragment
      const dpopJwt = await createDpopJwt(validPayload)
      const expectedMethod = "POST"
      const expectedUrl = "https://api.example.com/token?param=value#section"

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {expectedMethod, expectedUrl})()

      // Expect: Validation passes (query/fragment ignored)
      expect(result).toBeRight()
    })
  })

  describe("Bad Cases", () => {
    it("should reject missing required claims", async () => {
      // Given: Payload missing required claims
      const incompletePayload = {
        jti: "unique-jti-123"
        // Missing htm, htu
      }
      const dpopJwt = await createDpopJwt(incompletePayload)

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails (caught by jose requiredClaims check)
      expect(result).toBeLeftOf("dpop_missing_htu_claim")
    })

    it("should reject mismatched HTTP method", async () => {
      // Given: Valid payload but wrong method in claims
      const payload = {...validPayload, htm: "GET"}
      const dpopJwt = await createDpopJwt(payload)

      // When: Validate JWT against POST
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails with invalid htm claim
      expect(result).toBeLeftOf("dpop_invalid_htm_claim")
    })

    it("should reject mismatched URL", async () => {
      // Given: Valid payload but wrong URL in claims
      const payload = {...validPayload, htu: "https://api.example.com/wrong-endpoint"}
      const dpopJwt = await createDpopJwt(payload)

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails with invalid htu claim
      expect(result).toBeLeftOf("dpop_invalid_htu_claim")
    })

    it("should reject expired tokens", async () => {
      // Given: Token issued too long ago (1 minute more than max age)
      const oldTimestamp = Math.floor(Date.now() / 1000) - (DPOP_MAX_AGE_SECONDS + 60)
      const payload = {...validPayload, iat: oldTimestamp}
      // Note: createDpopJwt won't overwrite iat if present
      const dpopJwt = await createDpopJwt(payload)

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails (jose checks maxTokenAge)
      expect(result).toBeLeftOf("dpop_jwt_expired")
    })

    it("should reject tokens from the future (clock skew)", async () => {
      // Given: Token issued in the future
      const futureTimestamp = Math.floor(Date.now() / 1000) + 40 // 40 seconds in future
      const payload = {...validPayload, iat: futureTimestamp}
      const dpopJwt = await createDpopJwt(payload)

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails (jose checks clockTolerance)
      expect(result).toBeLeftOf("dpop_jwt_verify_failed")
    })

    it("should handle malformed URLs gracefully", async () => {
      // Given: Invalid URL in payload
      const payload = {...validPayload, htu: "not-a-valid-url"}
      const dpopJwt = await createDpopJwt(payload)

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails with URL parsing error
      expect(result).toBeLeftOf("dpop_htu_url_parsing_failed")
    })

    it("should reject invalid JWT format", async () => {
      // Given: Invalid JWT string
      const invalidJwt = "not.a.valid.jwt"

      // When: Validate JWT
      const result = await validateDpopJwt(invalidJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails with verify error
      expect(result).toBeLeftOf("dpop_jwt_invalid")
    })

    it("should reject wrong signature", async () => {
      // Given: JWT signed with different key
      const otherKeyPair = await jose.generateKeyPair("RS256")
      // Sign with OTHER private key
      const jwk = await jose.exportJWK(otherKeyPair.publicKey)
      const dpopJwt = await new jose.SignJWT(validPayload)
        .setProtectedHeader({
          alg: "RS256",
          typ: "dpop+jwt",
          jwk: jwk
        })
        .setIssuedAt()
        .sign(otherKeyPair.privateKey)

      // When: Validate with ORIGINAL public key
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails
      expect(result).toBeLeftOf("dpop_invalid_signature")
    })

    it("should reject invalid DPoP header type", async () => {
      // Given: JWT with wrong typ header
      const dpopJwt = await createDpopJwt(validPayload, {
        alg: "RS256",
        typ: "JWT", // Wrong type
        jwk: await jose.exportJWK(testAgentKeyPair.publicKey)
      })

      // When: Validate JWT
      const result = await validateDpopJwt(dpopJwt, testAgentPublicKeyPem, {
        expectedMethod: "POST",
        expectedUrl: "https://api.example.com/token"
      })()

      // Expect: Validation fails
      expect(result).toBeLeftOf("dpop_jwt_verify_failed")
    })
  })
})
