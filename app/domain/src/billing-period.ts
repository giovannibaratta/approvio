import {PrefixUnion} from "@utils"
import * as E from "fp-ts/Either"

export interface BillingPeriodDateRange {
  readonly periodStartsAt: Date
  readonly periodEndsAt: Date
}

export type InvalidBillingPeriodError = PrefixUnion<
  "billing_period",
  "invalid_format" | "invalid_month" | "invalid_year"
>

/**
 * Validates and parses a billing period string in 'YYYY-MM' format,
 * returning the start and end boundary dates (UTC).
 *
 * @param period - The period string (e.g., '2026-08').
 * @returns Either an error string or the UTC Date boundaries for the month.
 */
export function parseBillingPeriod(period: string): E.Either<InvalidBillingPeriodError, BillingPeriodDateRange> {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return E.left("billing_period_invalid_format")

  const yearStr = match[1]
  const monthStr = match[2]

  if (typeof yearStr !== "string" || typeof monthStr !== "string") return E.left("billing_period_invalid_format")

  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (isNaN(year) || year < 2000 || year > 2200) return E.left("billing_period_invalid_year")

  if (isNaN(month) || month < 1 || month > 12) return E.left("billing_period_invalid_month")

  const periodStartsAt = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
  const periodEndsAt = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))

  return E.right({periodStartsAt, periodEndsAt})
}

/**
 * Formats a Date object into a standard 'YYYY-MM' billing period string.
 *
 * @param date - The Date to format.
 * @returns The formatted period string.
 */
export function formatBillingPeriod(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}
