import {ActorType, CreateUsageEvent, UsageMetric} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {ActorUsageSummary, UnknownError, UsageEventRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"
import {DatabaseClient} from "./database-client"
import {mapToNullableJsonValue} from "./shared/json-mappers"

@Injectable()
export class PostgresUsageEventRepository implements UsageEventRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  public persist(data: CreateUsageEvent): TE.TaskEither<UnknownError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.usageEvent.create({
          data: this.mapToPrisma(data),
          select: {id: true}
        })
      },
      error => {
        Logger.error("Failed to persist usage event", error)
        return "unknown_error" as const
      }
    )
  }

  public persistBatch(data: CreateUsageEvent[]): TE.TaskEither<UnknownError, void> {
    if (data.length === 0) return TE.right(undefined)

    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.usageEvent.createMany({
          data: data.map(d => this.mapToPrisma(d))
        })
      },
      error => {
        Logger.error("Failed to persist batch usage events", error)
        return "unknown_error" as const
      }
    )
  }

  public getPeriodTotal(metric: UsageMetric, fromDate: Date, toDate: Date): TE.TaskEither<UnknownError, bigint> {
    return TE.tryCatch(
      async () => {
        const result = await this.dbClient.cx.usageEvent.aggregate({
          where: {
            metric,
            occurredAt: {
              gte: fromDate,
              lte: toDate
            }
          },
          _sum: {
            quantity: true
          }
        })
        return result._sum.quantity ?? 0n
      },
      error => {
        Logger.error("Failed to calculate period total for usage metric", error)
        return "unknown_error" as const
      }
    )
  }

  public getActorBreakdown(
    metric: UsageMetric,
    fromDate: Date,
    toDate: Date
  ): TE.TaskEither<UnknownError, ActorUsageSummary[]> {
    return TE.tryCatch(
      async () => {
        const groups = await this.dbClient.cx.usageEvent.groupBy({
          by: ["actorType", "actorId"],
          where: {
            metric,
            occurredAt: {
              gte: fromDate,
              lte: toDate
            }
          },
          _sum: {
            quantity: true
          }
        })

        return groups.map(group => {
          const actorType: ActorType = group.actorType === "agent" ? "agent" : "user"
          return {
            actor: {
              id: group.actorId,
              type: actorType
            },
            totalQuantity: group._sum.quantity ?? 0n
          }
        })
      },
      error => {
        Logger.error("Failed to get actor breakdown for usage metric", error)
        return "unknown_error" as const
      }
    )
  }

  private mapToPrisma(data: CreateUsageEvent): Prisma.UsageEventCreateInput {
    return {
      id: uuidv7(),
      entityType: data.entityType,
      entityId: data.entityId,
      actorType: data.actor.type,
      actorId: data.actor.id,
      metric: data.metric,
      quantity: data.quantity,
      isBillable: data.isBillable,
      occurredAt: data.occurredAt,
      metadata: mapToNullableJsonValue(data.metadata)
    }
  }
}
