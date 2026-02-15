import {Quota, QuotaMetric, QuotaScope} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {QuotaGetError, QuotaRepository} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {v4 as uuidv4} from "uuid"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"

@Injectable()
export class QuotaDbRepository implements QuotaRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getQuota(scope: QuotaScope, metric: QuotaMetric): TE.TaskEither<QuotaGetError, Quota> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.findUnique({
            where: {
              scope_metric: {
                scope,
                metric
              }
            }
          }),
        error => {
          Logger.error("Error retrieving quota", error)
          return "unknown_error" as const
        }
      ),
      TE.chain(quota => {
        if (!quota) return TE.left("quota_not_found" as const)
        return TE.right({
          ...quota,
          scope: quota.scope as QuotaScope,
          metric: quota.metric as QuotaMetric
        })
      })
    )
  }

  upsertQuota(scope: QuotaScope, metric: QuotaMetric, limit: number): TE.TaskEither<unknown, Quota> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.upsert({
            where: {
              scope_metric: {
                scope,
                metric
              }
            },
            create: {
              id: uuidv4(),
              scope,
              metric,
              limit,
              createdAt: new Date(),
              updatedAt: new Date(),
              occ: POSTGRES_BIGINT_LOWER_BOUND
            },
            update: {
              limit,
              updatedAt: new Date(),
              occ: {increment: 1}
            }
          }),
        error => {
          Logger.error("Error upserting quota", error)
          return error
        }
      ),
      TE.map(quota => ({
        ...quota,
        scope: quota.scope as QuotaScope,
        metric: quota.metric as QuotaMetric
      }))
    )
  }
}
