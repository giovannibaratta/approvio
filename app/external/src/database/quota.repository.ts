import {Quota, QuotaFactory, QuotaIdentifier, Versioned, QuotaValidationError} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {
  QuotaCreateError,
  QuotaGetError,
  QuotaRepository,
  QuotaUpdateError,
  QuotaListError,
  QuotaDeleteError,
  ListQuotasFilter,
  ListQuotasResult
} from "@services"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {Prisma} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as RA from "fp-ts/ReadonlyArray"

@Injectable()
export class QuotaDbRepository implements QuotaRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getQuotaById(id: string): TE.TaskEither<QuotaGetError, Versioned<Quota>> {
    return pipe(
      TE.tryCatch(
        () => this.dbClient.quota.findUnique({where: {id}}),
        error => {
          Logger.error("Error retrieving quota by id", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(quota => (quota ? TE.fromEither(this.mapToVersionedQuota(quota)) : TE.left("quota_not_found" as const)))
    )
  }

  getQuota(identifier: QuotaIdentifier): TE.TaskEither<QuotaGetError, Versioned<Quota>> {
    const scope = identifier.node.type
    const targetId = identifier.node.identifier

    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.findUnique({
            where: {
              scope_quotaType_targetId: {
                scope: scope,
                quotaType: identifier.quotaType,
                targetId: targetId
              }
            }
          }),
        error => {
          Logger.error("Error retrieving quota", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(quota => (quota ? TE.fromEither(this.mapToVersionedQuota(quota)) : TE.left("quota_not_found" as const)))
    )
  }

  createQuota(quota: Quota): TE.TaskEither<QuotaCreateError, Versioned<Quota>> {
    const scope = quota.node.type
    const targetId = quota.node.identifier

    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.quota.create({
            data: {
              id: quota.id,
              scope: scope,
              quotaType: quota.quotaType,
              limit: quota.limit,
              createdAt: quota.createdAt,
              updatedAt: quota.updatedAt,
              targetId: targetId,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["scope", "quota_type", "target_id"]))
            return "quota_already_exists" as const
          Logger.error("Error creating quota", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainW(createdQuota => TE.fromEither(this.mapToVersionedQuota(createdQuota)))
    )
  }

  updateQuota(quota: Quota, occCheck: bigint): TE.TaskEither<QuotaUpdateError, Versioned<Quota>> {
    const scope = quota.node.type
    const targetId = quota.node.identifier

    return pipe(
      TE.tryCatch(
        async () => {
          return await this.dbClient.$transaction(async tx => {
            const updatedQuotas = await tx.quota.updateManyAndReturn({
              where: {
                scope: scope,
                quotaType: quota.quotaType,
                targetId: targetId,
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
                  scope_quotaType_targetId: {
                    scope: scope,
                    quotaType: quota.quotaType,
                    targetId: targetId
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
        return TE.fromEither(this.mapToVersionedQuota(result))
      })
    )
  }

  deleteQuota(id: string): TE.TaskEither<QuotaDeleteError, void> {
    return pipe(
      TE.tryCatch(
        async () => {
          await this.dbClient.quota.delete({where: {id}})
        },
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Quota)) return "quota_not_found" as const
          Logger.error("Error deleting quota", error)
          return "quota_unknown_error" as const
        }
      )
    )
  }

  listQuotas(page: number, limit: number, filter?: ListQuotasFilter): TE.TaskEither<QuotaListError, ListQuotasResult> {
    return pipe(
      TE.tryCatch(
        async () => {
          const where: Prisma.QuotaWhereInput = {}
          if (filter) {
            if (filter.nodeType) where.scope = filter.nodeType
            if (filter.quotaType) where.quotaType = filter.quotaType
            if (filter.nodeIdentifier) where.targetId = filter.nodeIdentifier
          }

          const [total, items] = await this.dbClient.$transaction([
            this.dbClient.quota.count({where}),
            this.dbClient.quota.findMany({
              where,
              take: limit,
              skip: (page - 1) * limit,
              orderBy: [{createdAt: "desc"}, {id: "desc"}]
            })
          ])

          return {total, items}
        },
        error => {
          Logger.error("Error listing quotas", error)
          return "quota_unknown_error" as const
        }
      ),
      TE.chainEitherKW(({total, items}) =>
        pipe(
          items,
          RA.traverse(E.Applicative)(item => this.mapToVersionedQuota(item)),
          E.map(parsedItems => ({
            items: [...parsedItems],
            total,
            page,
            limit
          }))
        )
      )
    )
  }

  private mapToVersionedQuota(quota: Prisma.QuotaModel): E.Either<QuotaValidationError, Versioned<Quota>> {
    const node = {type: quota.scope, identifier: quota.targetId}

    const domainData = {
      ...quota,
      node
    }

    return pipe(
      QuotaFactory.validate(domainData),
      E.map(validQuota => ({...validQuota, occ: quota.occ}))
    )
  }
}
