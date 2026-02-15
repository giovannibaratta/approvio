import {Quota, QuotaMetric, QuotaScope} from "@domain"
import {TaskEither} from "fp-ts/lib/TaskEither"

export type QuotaGetError = "quota_not_found" | "unknown_error"

export interface QuotaRepository {
  getQuota(scope: QuotaScope, metric: QuotaMetric): TaskEither<QuotaGetError, Quota>
  upsertQuota(scope: QuotaScope, metric: QuotaMetric, limit: number): TaskEither<unknown, Quota>
}
export const QUOTA_REPOSITORY_TOKEN = Symbol("QUOTA_REPOSITORY_TOKEN")
