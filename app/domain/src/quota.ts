export type QuotaScope = "GLOBAL" | "SPACE" | "GROUP" | "TEMPLATE" | "USER"

export type QuotaMetric =
  | "MAX_GROUPS"
  | "MAX_SPACES"
  | "MAX_TEMPLATES"
  | "MAX_USERS"
  | "MAX_CONCURRENT_WORKFLOWS"
  | "MAX_ROLES"

export interface Quota {
  readonly id: string
  readonly scope: QuotaScope
  readonly metric: QuotaMetric
  readonly limit: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly occ: bigint
}

export type QuotaValidationError = "invalid_scope" | "invalid_metric" | "invalid_limit"
