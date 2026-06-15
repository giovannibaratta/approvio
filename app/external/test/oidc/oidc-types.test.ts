import * as E from "fp-ts/Either"
import {validateUserInfoResponse, RawUserInfoResponse} from "../../src/oidc/oidc-types"
import {unwrapRight, unwrapLeft} from "@utils/either"
import "expect-more-jest"

describe("validateUserInfoResponse", () => {
  describe("good cases", () => {
    it("should validate minimal valid response with only required sub claim", () => {
      // Given: minimal valid UserInfo response
      const rawResponse: RawUserInfoResponse = {
        sub: "user-12345"
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with only sub claim
      expect(E.isRight(result)).toBe(true)

      const validatedInfo = unwrapRight(result)
      expect(validatedInfo.sub).toBe("user-12345")
      expect(validatedInfo.name).toBeUndefined()
      expect(validatedInfo.email).toBeUndefined()
      expect(validatedInfo.emailVerified).toBeUndefined()
      expect(validatedInfo.preferredUsername).toBeUndefined()
      expect(validatedInfo.givenName).toBeUndefined()
      expect(validatedInfo.familyName).toBeUndefined()
    })

    it("should validate full valid response with all optional claims", () => {
      // Given: complete valid UserInfo response
      const rawResponse: RawUserInfoResponse = {
        sub: "user-12345",
        name: "John Doe",
        email: "john.doe@example.com",
        email_verified: true,
        preferred_username: "johndoe",
        given_name: "John",
        family_name: "Doe"
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with all claims preserved
      expect(E.isRight(result)).toBe(true)
      const validatedInfo = unwrapRight(result)
      expect(validatedInfo.sub).toBe("user-12345")
      expect(validatedInfo.name).toBe("John Doe")
      expect(validatedInfo.email).toBe("john.doe@example.com")
      expect(validatedInfo.emailVerified).toBe(true)
      expect(validatedInfo.preferredUsername).toBe("johndoe")
      expect(validatedInfo.givenName).toBe("John")
      expect(validatedInfo.familyName).toBe("Doe")
    })

    it("should validate partial valid response with some optional claims", () => {
      // Given: partial valid UserInfo response
      const rawResponse: RawUserInfoResponse = {
        sub: "user-67890",
        name: "Jane Smith",
        email: "jane@example.com",
        email_verified: false
        // preferred_username, given_name, family_name omitted
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with present claims only
      expect(E.isRight(result)).toBe(true)
      const validatedInfo = unwrapRight(result)
      expect(validatedInfo.sub).toBe("user-67890")
      expect(validatedInfo.name).toBe("Jane Smith")
      expect(validatedInfo.email).toBe("jane@example.com")
      expect(validatedInfo.emailVerified).toBe(false)
      expect(validatedInfo.preferredUsername).toBeUndefined()
      expect(validatedInfo.givenName).toBeUndefined()
      expect(validatedInfo.familyName).toBeUndefined()
    })

    it("should validate response with email_verified as true", () => {
      // Given: UserInfo response with verified email
      const rawResponse: RawUserInfoResponse = {
        sub: "verified-user",
        email: "verified@example.com",
        email_verified: true
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with email_verified as boolean
      expect(E.isRight(result)).toBe(true)
      expect(unwrapRight(result).emailVerified).toBe(true)
    })

    it("should accept response with string email_verified claim", () => {
      // Given: response with string email_verified

      const valuesToValidate = ["true", "TRUE", "false", "FALSE", "TRue", "fAlSe"]

      for (const value of valuesToValidate) {
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",
          email: "test@example.com",

          email_verified: value
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation succeeds and converts to boolean
        expect(E.isRight(result)).toBe(true)
        expect(unwrapRight(result).emailVerified).toBeBoolean()
      }
    })

    it("should validate response with email_verified as false", () => {
      // Given: UserInfo response with unverified email
      const rawResponse: RawUserInfoResponse = {
        sub: "unverified-user",
        email: "unverified@example.com",
        email_verified: false
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with email_verified as boolean
      expect(E.isRight(result)).toBe(true)
      expect(unwrapRight(result).emailVerified).toBe(false)
    })

    it("should handle response with null/undefined optional claims by omitting them", () => {
      // Given: UserInfo response with null/undefined optional claims
      const rawResponse: RawUserInfoResponse = {
        sub: "user-nulls",
        name: null,
        email: undefined,
        preferred_username: null,
        given_name: undefined,
        family_name: null
      }

      // When: validating the response
      const result = validateUserInfoResponse(rawResponse)

      // Expect: validation succeeds with null/undefined claims omitted
      expect(E.isRight(result)).toBe(true)
      const validatedInfo = unwrapRight(result)
      expect(validatedInfo.sub).toBe("user-nulls")
      expect(validatedInfo.name).toBeUndefined()
      expect(validatedInfo.email).toBeUndefined()
      expect(validatedInfo.preferredUsername).toBeUndefined()
      expect(validatedInfo.givenName).toBeUndefined()
      expect(validatedInfo.familyName).toBeUndefined()
    })
  })

  describe("bad cases", () => {
    describe("invalid_json_structure", () => {
      it("should reject null response", () => {
        // Given: null response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = null as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })

      it("should reject undefined response", () => {
        // Given: undefined response
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = undefined as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })

      it("should reject string response", () => {
        // Given: string instead of object
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = "not an object" as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })

      it("should reject number response", () => {
        // Given: number instead of object
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = 12345 as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })

      it("should reject boolean response", () => {
        // Given: boolean instead of object
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = true as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })

      it("should reject array response", () => {
        // Given: array instead of object
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResponse = ["not", "an", "object"] as any

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_json_structure error
        expect(unwrapLeft(result)).toBe("invalid_json_structure")
      })
    })

    describe("missing_required_sub_claim", () => {
      it("should reject response without sub claim", () => {
        // Given: response without sub claim
        const rawResponse: RawUserInfoResponse = {
          name: "John Doe",
          email: "john@example.com"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with missing_required_sub_claim error
        expect(unwrapLeft(result)).toBe("missing_required_sub_claim")
      })

      it("should reject response with null sub claim", () => {
        // Given: response with null sub
        const rawResponse: RawUserInfoResponse = {
          sub: null,
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with missing_required_sub_claim error
        expect(unwrapLeft(result)).toBe("missing_required_sub_claim")
      })

      it("should reject response with undefined sub claim", () => {
        // Given: response with undefined sub
        const rawResponse: RawUserInfoResponse = {
          sub: undefined,
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with missing_required_sub_claim error
        expect(unwrapLeft(result)).toBe("missing_required_sub_claim")
      })
    })

    describe("invalid_sub_claim_type", () => {
      it("should reject response with number sub claim", () => {
        // Given: response with number sub
        const rawResponse: RawUserInfoResponse = {
          sub: 12345,
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })

      it("should reject response with boolean sub claim", () => {
        // Given: response with boolean sub
        const rawResponse: RawUserInfoResponse = {
          sub: true,
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })

      it("should reject response with object sub claim", () => {
        // Given: response with object sub
        const rawResponse: RawUserInfoResponse = {
          sub: {id: "user-123"},
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })

      it("should reject response with array sub claim", () => {
        // Given: response with array sub
        const rawResponse: RawUserInfoResponse = {
          sub: ["user", "123"],
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })

      it("should reject response with empty string sub claim", () => {
        // Given: response with empty sub
        const rawResponse: RawUserInfoResponse = {
          sub: "",
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })

      it("should reject response with whitespace-only sub claim", () => {
        // Given: response with whitespace-only sub
        const rawResponse: RawUserInfoResponse = {
          sub: "   \t\n   ",
          name: "John Doe"
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_sub_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_sub_claim_type")
      })
    })

    describe("invalid_claim_type", () => {
      it("should reject response with number name claim", () => {
        // Given: response with number name
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",

          name: 12345
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with boolean email claim", () => {
        // Given: response with boolean email
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",

          email: true
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with object preferred_username claim", () => {
        // Given: response with object preferred_username
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",

          preferred_username: {username: "johndoe"}
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with array given_name claim", () => {
        // Given: response with array given_name
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",

          given_name: ["John", "Middle"]
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with number family_name claim", () => {
        // Given: response with number family_name
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",

          family_name: 67890
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with number email_verified claim", () => {
        // Given: response with number email_verified
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",
          email: "test@example.com",

          email_verified: 1
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })

      it("should reject response with object email_verified claim", () => {
        // Given: response with object email_verified
        const rawResponse: RawUserInfoResponse = {
          sub: "user-123",
          email: "test@example.com",

          email_verified: {verified: true}
        }

        // When: validating the response
        const result = validateUserInfoResponse(rawResponse)

        // Expect: validation fails with invalid_claim_type error
        expect(unwrapLeft(result)).toBe("invalid_claim_type")
      })
    })
  })
})
