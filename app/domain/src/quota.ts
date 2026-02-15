import {PrefixUnion} from "@utils"
import {v4 as uuid} from "uuid"
import {isObject, isUUIDv4} from "@utils/validation"
import {Either, isLeft, left, right} from "fp-ts/Either"

const quotasMap = {
  GROUP: ["MAX_ENTITIES_PER_GROUP"],
  TEMPLATE: ["MAX_CONCURRENT_WORKFLOWS"],
  USER: ["MAX_ROLES_PER_USER"],
  GLOBAL: ["MAX_GROUPS", "MAX_SPACES"],
  SPACE: ["MAX_TEMPLATES"]
} as const

export type QuotaScope = keyof typeof quotasMap
// [number] extract the string literals from the arrays
export type QuotaMetric = (typeof quotasMap)[QuotaScope][number]

type QuotasMap = typeof quotasMap

export type QuotaIdentifier = {
  [K in keyof QuotasMap]: {
    scope: K
    metric: QuotasMap[K][number]
  }
}[keyof QuotasMap]

export type Quota = QuotaIdentifier & {
  readonly id: string
  readonly limit: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type QuotaValidationError = PrefixUnion<
  "quota",
  "invalid_id" | "malformed_quota" | "invalid_scope" | "invalid_metric" | "invalid_limit"
>

function isQuotaScope(val: string): val is QuotaScope {
  return val in quotasMap
}

function isQuotaMetric(val: string): val is QuotaMetric {
  return Object.values(quotasMap)
    .flat()
    .map(m => m.toString())
    .includes(val)
}

function validateMetricForScope(metric: QuotaMetric, scope: QuotaScope): Either<QuotaValidationError, QuotaIdentifier> {
  const allowedMetrics = quotasMap[scope].map(m => m.toString())
  if (!allowedMetrics.includes(metric)) return left("quota_invalid_metric")
  return right({scope, metric} as QuotaIdentifier)
}

export class QuotaFactory {
  static validate(data: unknown): Either<QuotaValidationError, Quota> {
    if (!isObject(data)) return left("quota_malformed_quota")

    if (typeof data.id !== "string") return left("quota_malformed_quota")
    if (!isUUIDv4(data.id)) return left("quota_invalid_id")
    if (typeof data.scope !== "string" || !isQuotaScope(data.scope)) return left("quota_invalid_scope")
    if (typeof data.metric !== "string" || !isQuotaMetric(data.metric)) return left("quota_invalid_metric")
    if (typeof data.limit !== "number" || !Number.isInteger(data.limit) || data.limit < 0)
      return left("quota_invalid_limit")
    if (!(data.createdAt instanceof Date)) return left("quota_malformed_quota")
    if (!(data.updatedAt instanceof Date)) return left("quota_malformed_quota")

    const metric = data.metric
    const scope = data.scope

    const metricIdentifier = validateMetricForScope(metric, scope)

    if (isLeft(metricIdentifier)) return metricIdentifier

    return right({
      id: data.id,
      ...metricIdentifier.right,
      limit: data.limit,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    })
  }

  static newQuota(identifier: QuotaIdentifier, limit: number): Either<QuotaValidationError, Quota> {
    const now = new Date()

    return this.validate({
      id: uuid(),
      ...identifier,
      limit,
      updatedAt: now,
      createdAt: now
    })
  }
}
