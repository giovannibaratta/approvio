import * as E from "fp-ts/Either"
import {fromPromise, fromEitherPromise} from "./repository-operation"
import {
  isOriginatingActor,
  TenantContext,
  UsageMetric,
  UsageEvent,
  UsageEventFactory,
  UsageEventValidationError
} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {ActorUsageSummary, UnknownError, UsageEventRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {UsageEventTenantClient} from "./tenant-database-clients"
import {mapToNullableJsonValue} from "./shared/json-mappers"

@Injectable()
export class PostgresUsageEventRepository implements UsageEventRepository {
  constructor(private readonly dbClient: UsageEventTenantClient) {}

  public persist(data: UsageEvent): TE.TaskEither<UnknownError, void> {
    return fromPromise(
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

  public getOrCreateById(data: UsageEvent): TE.TaskEither<UnknownError | UsageEventValidationError, UsageEvent> {
    return fromEitherPromise(
      async () => {
        // Insert first: skipDuplicates handles a concurrent insert without failing the transaction.
        const [created] = await this.dbClient.cx.usageEvent.createManyAndReturn({
          data: [this.mapToPrisma(data)],
          skipDuplicates: true
        })
        const stored =
          created ??
          (await this.dbClient.cx.usageEvent.findUniqueOrThrow({
            where: {organizationId_id: {organizationId: data.organizationId, id: data.id}}
          }))
        return UsageEventFactory.validate({
          ...stored,
          actor: {id: stored.actorId, type: stored.actorType, displayName: stored.actorDisplayName}
        })
      },
      error => {
        Logger.error("Failed to persist usage event for operation", error instanceof Error ? error.name : "non_error")
        return "unknown_error" as const
      }
    )
  }

  public persistBatch(data: UsageEvent[]): TE.TaskEither<UnknownError, void> {
    if (data.length === 0) return TE.right(undefined)

    return fromPromise(
      async () => {
        await this.dbClient.cx.usageEvent.createMany({
          data: data.map(event => this.mapToPrisma(event))
        })
      },
      error => {
        Logger.error("Failed to persist batch usage events", error)
        return "unknown_error" as const
      }
    )
  }

  public getPeriodTotal(
    context: TenantContext,
    metric: UsageMetric,
    fromDate: Date,
    toDate: Date
  ): TE.TaskEither<UnknownError, bigint> {
    return fromPromise(
      async () => {
        const result = await this.dbClient.cx.usageEvent.aggregate({
          where: {
            organizationId: context.organizationId,
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
    context: TenantContext,
    metric: UsageMetric,
    fromDate: Date,
    toDate: Date
  ): TE.TaskEither<UnknownError, ActorUsageSummary[]> {
    return fromEitherPromise(
      async () => {
        const groups = await this.dbClient.cx.usageEvent.groupBy({
          by: ["actorType", "actorId", "actorDisplayName"],
          where: {
            organizationId: context.organizationId,
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

        return E.map((items: ReadonlyArray<ActorUsageSummary>) => [...items])(
          E.sequenceArray(
            groups.map(group => {
              const actor = {id: group.actorId, type: group.actorType, displayName: group.actorDisplayName}
              return isOriginatingActor(actor)
                ? E.right({actor, totalQuantity: group._sum.quantity ?? 0n})
                : E.left("unknown_error" as const)
            })
          )
        )
      },
      error => {
        Logger.error("Failed to get actor breakdown for usage metric", error)
        return "unknown_error" as const
      }
    )
  }

  private mapToPrisma(data: UsageEvent): Prisma.UsageEventCreateManyInput {
    return {
      id: data.id,
      organizationId: data.organizationId,
      entityType: data.entityType,
      entityId: data.entityId,
      actorType: data.actor.type,
      actorId: data.actor.id,
      actorDisplayName: data.actor.displayName,
      metric: data.metric,
      quantity: data.quantity,
      isBillable: data.isBillable,
      occurredAt: data.occurredAt,
      metadata: mapToNullableJsonValue(data.metadata)
    }
  }
}
