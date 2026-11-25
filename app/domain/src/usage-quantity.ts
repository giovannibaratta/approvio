import {Either, left, right} from "fp-ts/Either"

/** Shared storage range for PostgreSQL bigint and metering counters. */
export const MAX_USAGE_QUANTITY = 9223372036854775807n

export type UsageQuotaLimit = bigint | "UNLIMITED"

export function isUsageQuantity(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= MAX_USAGE_QUANTITY
}

export function parseUsageQuantity(value: unknown): Either<"invalid_usage", bigint> {
  if (typeof value !== "string" || value.length > 19 || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(value))
    return left("invalid_usage")
  const quantity = BigInt(value)
  return isUsageQuantity(quantity) ? right(quantity) : left("invalid_usage")
}
