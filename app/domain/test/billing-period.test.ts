import {formatBillingPeriod, parseBillingPeriod} from "../src/billing-period"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("BillingPeriod Domain Utilities", () => {
  describe("parseBillingPeriod", () => {
    it("should correctly parse valid YYYY-MM periods to UTC boundary dates", () => {
      // When
      const result = parseBillingPeriod("2026-08")

      // Expect
      expect(result).toBeRight()
      const {periodStartsAt, periodEndsAt} = unwrapRight(result)
      expect(periodStartsAt.toISOString()).toBe("2026-08-01T00:00:00.000Z")
      expect(periodEndsAt.toISOString()).toBe("2026-08-31T23:59:59.999Z")
    })

    it("should handle February leap years and 30-day months", () => {
      // February in non-leap year (2025)
      const feb2025 = unwrapRight(parseBillingPeriod("2025-02"))
      expect(feb2025.periodEndsAt.toISOString()).toBe("2025-02-28T23:59:59.999Z")

      // February in leap year (2028)
      const feb2028 = unwrapRight(parseBillingPeriod("2028-02"))
      expect(feb2028.periodEndsAt.toISOString()).toBe("2028-02-29T23:59:59.999Z")

      // April (30 days)
      const apr = unwrapRight(parseBillingPeriod("2026-04"))
      expect(apr.periodEndsAt.toISOString()).toBe("2026-04-30T23:59:59.999Z")
    })

    it("should reject malformed period formats", () => {
      expect(parseBillingPeriod("invalid")).toBeLeftOf("billing_period_invalid_format")
      expect(parseBillingPeriod("2026/08")).toBeLeftOf("billing_period_invalid_format")
      expect(parseBillingPeriod("2026-8")).toBeLeftOf("billing_period_invalid_format")
      expect(parseBillingPeriod("")).toBeLeftOf("billing_period_invalid_format")
    })

    it("should reject invalid month numbers", () => {
      expect(parseBillingPeriod("2026-00")).toBeLeftOf("billing_period_invalid_month")
      expect(parseBillingPeriod("2026-13")).toBeLeftOf("billing_period_invalid_month")
    })

    it("should reject out-of-range years", () => {
      expect(parseBillingPeriod("1999-05")).toBeLeftOf("billing_period_invalid_year")
      expect(parseBillingPeriod("2250-05")).toBeLeftOf("billing_period_invalid_year")
    })
  })

  describe("formatBillingPeriod", () => {
    it("should format date to YYYY-MM UTC string", () => {
      const date = new Date("2026-08-15T12:00:00.000Z")
      expect(formatBillingPeriod(date)).toBe("2026-08")
    })
  })
})
