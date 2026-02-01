import {eitherParseInt, eitherParseOptionalBoolean} from "@utils/validation"

describe("eitherParseInt", () => {
  describe("good cases", () => {
    it("should parse valid integer string", () => {
      // Given: A valid integer string
      const value = "42"

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Right with parsed integer
      expect(result).toBeRightOf(42)
    })

    it("should parse negative integer string", () => {
      // Given: A negative integer string
      const value = "-123"

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Right with parsed negative integer
      expect(result).toBeRightOf(-123)
    })

    it("should parse zero", () => {
      // Given: Zero as string
      const value = "0"

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Right with zero
      expect(result).toBeRightOf(0)
    })

    it("should parse with custom base (hexadecimal)", () => {
      // Given: A hexadecimal string
      const value = "FF"

      // When: Parse with base 16
      const result = eitherParseInt(value, "error", 16)

      // Expect: Right with parsed value
      expect(result).toBeRightOf(255)
    })

    it("should parse with custom base (binary)", () => {
      // Given: A binary string
      const value = "1010"

      // When: Parse with base 2
      const result = eitherParseInt(value, "error", 2)

      // Expect: Right with parsed value
      expect(result).toBeRightOf(10)
    })

    it("should parse string with leading whitespace", () => {
      // Given: String with leading whitespace
      const value = "  42"

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Right with parsed integer (parseInt trims)
      expect(result).toBeRightOf(42)
    })
  })

  describe("bad cases", () => {
    it("should return left for non-string value (number)", () => {
      // Given: A number instead of string
      const value = 42

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for non-string value (object)", () => {
      // Given: An object
      const value = {num: 42}

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for non-string value (null)", () => {
      // Given: null value
      const value = null

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for non-string value (undefined)", () => {
      // Given: undefined value
      const value = undefined

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for non-numeric string", () => {
      // Given: A non-numeric string
      const value = "not a number"

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for empty string", () => {
      // Given: An empty string
      const value = ""

      // When: Parse the value
      const result = eitherParseInt(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should preserve custom left value type", () => {
      // Given: A custom error object
      const customError = {code: "PARSE_ERROR", message: "Failed to parse"}
      const value = "invalid"

      // When: Parse the value
      const result = eitherParseInt(value, customError)

      // Expect: Left with custom error object
      expect(result).toBeLeftOf(customError)
    })
  })
})

describe("eitherParseOptionalBoolean", () => {
  describe("good cases", () => {
    it("should return right(undefined) for undefined value", () => {
      // Given: undefined value
      const value = undefined

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with undefined
      expect(result).toBeRightOf(undefined)
    })

    it("should return right(true) for boolean true", () => {
      // Given: Boolean true
      const value = true

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with true
      expect(result).toBeRightOf(true)
    })

    it("should return right(false) for boolean false", () => {
      // Given: Boolean false
      const value = false

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with false
      expect(result).toBeRightOf(false)
    })

    it("should parse string 'true' to boolean true", () => {
      // Given: String "true"
      const value = "true"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with true
      expect(result).toBeRightOf(true)
    })

    it("should parse string 'false' to boolean false", () => {
      // Given: String "false"
      const value = "false"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with false
      expect(result).toBeRightOf(false)
    })

    it("should handle uppercase 'TRUE'", () => {
      // Given: Uppercase "TRUE"
      const value = "TRUE"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with true
      expect(result).toBeRightOf(true)
    })

    it("should handle uppercase 'FALSE'", () => {
      // Given: Uppercase "FALSE"
      const value = "FALSE"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with false
      expect(result).toBeRightOf(false)
    })

    it("should handle mixed case 'TrUe'", () => {
      // Given: Mixed case "TrUe"
      const value = "TrUe"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with true
      expect(result).toBeRightOf(true)
    })

    it("should handle string with leading/trailing whitespace", () => {
      // Given: String with whitespace
      const value = "  true  "

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Right with true
      expect(result).toBeRightOf(true)
    })
  })

  describe("bad cases", () => {
    it("should return left for number value", () => {
      // Given: A number
      const value = 1

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for object value", () => {
      // Given: An object
      const value = {bool: true}

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for null value", () => {
      // Given: null
      const value = null

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for array value", () => {
      // Given: An array
      const value = [true]

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for invalid string 'yes'", () => {
      // Given: String "yes"
      const value = "yes"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for invalid string '1'", () => {
      // Given: String "1"
      const value = "1"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for invalid string '0'", () => {
      // Given: String "0"
      const value = "0"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should return left for empty string", () => {
      // Given: Empty string
      const value = ""

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, "error")

      // Expect: Left with error value
      expect(result).toBeLeftOf("error")
    })

    it("should preserve custom left value type", () => {
      // Given: A custom error object
      const customError = {code: "INVALID_BOOLEAN", message: "Not a valid boolean"}
      const value = "invalid"

      // When: Parse the value
      const result = eitherParseOptionalBoolean(value, customError)

      // Expect: Left with custom error object
      expect(result).toBeLeftOf(customError)
    })
  })
})
