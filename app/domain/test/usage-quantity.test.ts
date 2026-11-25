import {isUsageQuantity, MAX_USAGE_QUANTITY, parseUsageQuantity} from "../src/usage-quantity"
import "@utils/matchers"

describe("usage quantities", () => {
  it.each(["0", "9007199254740993", "9223372036854775807"])("parses exact decimal integer %s", value => {
    const result = parseUsageQuantity(value)
    expect(result).toBeRightOf(BigInt(value))
  })

  it.each([0, 1n, "", "01", "-1", "+1", "1.0", "1e3", " 1", "1\n", "1\r\n", "9223372036854775808"])(
    "rejects noncanonical or out-of-range input %p",
    value => {
      const result = parseUsageQuantity(value)
      expect(result).toBeLeftOf("invalid_usage")
    }
  )

  it("bounds native bigint quantities to nonnegative PostgreSQL integers", () => {
    expect(isUsageQuantity(0n)).toBe(true)
    expect(isUsageQuantity(MAX_USAGE_QUANTITY)).toBe(true)
    expect(isUsageQuantity(-1n)).toBe(false)
    expect(isUsageQuantity(MAX_USAGE_QUANTITY + 1n)).toBe(false)
    expect(isUsageQuantity(1)).toBe(false)
  })
})
