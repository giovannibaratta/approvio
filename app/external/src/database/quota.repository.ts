import {Quota, QuotaFactory, QuotaIdentifier, Versioned} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {QuotaCreateError, QuotaGetError, QuotaRepository, QuotaUpdateError} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class QuotaDbRepository implements QuotaRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getQuota(identifier: QuotaIdentifier): TE.TaskEither<QuotaGetError, Versioned<Quota>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.findUnique({
            where: {
              scope_metric: {
                scope: identifier.scope,
                metric: identifier.metric
              }
            }
          }),
        error => {
          Logger.error("Error retrieving quota", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(quota => {
        if (!quota) return TE.left("quota_not_found" as const)
        return pipe(
          TE.fromEither(QuotaFactory.validate(quota)),
          TE.map(validQuota => ({...validQuota, occ: quota.occ}))
        )
      })
    )
  }

  createQuota(quota: Quota): TE.TaskEither<QuotaCreateError, Versioned<Quota>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.create({
            data: {
              id: quota.id,
              scope: quota.scope,
              metric: quota.metric,
              limit: quota.limit,
              createdAt: quota.createdAt,
              updatedAt: quota.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["scope", "metric"])) return "quota_already_exists" as const
          Logger.error("Error creating quota", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(createdQuota =>
        pipe(
          TE.fromEither(QuotaFactory.validate(createdQuota)),
          TE.map(validQuota => ({...validQuota, occ: createdQuota.occ}))
        )
      )
    )
  }

  updateQuota(quota: Quota, occCheck: bigint): TE.TaskEither<QuotaUpdateError, Versioned<Quota>> {
    return pipe(
      TE.tryCatch(
        async () => {
          return await this.dbClient.$transaction(async tx => {
            const updatedQuotas = await tx.quota.updateManyAndReturn({
              where: {
                scope: quota.scope,
                metric: quota.metric,
                occ: occCheck
              },
              data: {
                limit: quota.limit,
                createdAt: quota.createdAt,
                updatedAt: quota.updatedAt,
                occ: {increment: 1}
              }
            })

            if (updatedQuotas.length === 0) {
              // Check if it failed due to OCC or Not Found
              const existing = await tx.quota.findUnique({
                where: {
                  scope_metric: {
                    scope: quota.scope,
                    metric: quota.metric
                  }
                }
              })

              if (!existing) return "quota_not_found"
              if (existing.occ !== occCheck) return "quota_concurrent_modification_error"
              Logger.error("Error updating quota, quota exists and with the same occ", {existing, occCheck})
              return "quota_unknown_error"
            }

            const item = updatedQuotas[0]

            if (!item) {
              Logger.error("Error updating quota, no item returned", {updatedQuotas})
              return "quota_unknown_error"
            }

            return item
          })
        },
        error => {
          Logger.error("Error updating quota", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(result => {
        if (typeof result === "string") return TE.left(result)
        return pipe(
          TE.fromEither(QuotaFactory.validate(result)),
          TE.map(validQuota => ({...validQuota, occ: result.occ}))
        )
      })
    )
  }
}
