import {ActorType, CreateUsageEvent, TenantContext, UsageMetric} from "@domain"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {ActorUsageSummary, UnknownError, UsageEventRepository} from "@services"
import * as TE from "fp-ts/TaskEither"
import {v7 as uuidv7} from "uuid"
import {UsageEventTenantClient} from "./tenant-database-clients"
import {mapToNullableJsonValue} from "./shared/json-mappers"
import {generateDeterministicId} from "@utils"

@Injectable()
export class PostgresUsageEventRepository implements UsageEventRepository {
  constructor(private readonly dbClient: UsageEventTenantClient) {}

  public persist(
    context: TenantContext,
    data: CreateUsageEvent
  ): TE.TaskEither<UnknownError | "organization_mismatch", void> {
    if (data.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.usageEvent.create({
          data: this.mapToPrisma(context, data),
          select: {id: true}
        })
      },
      error => {
        Logger.error("Failed to persist usage event", error)
        return "unknown_error" as const
      }
    )
  }

  public persistOperation(
    context: TenantContext,
    operationId: string,
    data: CreateUsageEvent
  ): TE.TaskEither<UnknownError | "organization_mismatch" | "event_mismatch", void> {
    if (data.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () => {
        const id = generateDeterministicId(`usage-event-${context.organizationId}-${operationId}`)
        const existing = await this.dbClient.cx.usageEvent.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id}}
        })
        if (existing) {
          if (!sameUsageEvent(existing, data)) throw new UsageEventMismatchError()
          return
        }
        const result = await this.dbClient.cx.usageEvent.createMany({
          data: [this.mapToPrisma(context, data, id)],
          skipDuplicates: true
        })
        if (result.count === 0) {
          const concurrent = await this.dbClient.cx.usageEvent.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id}}
          })
          if (!concurrent || !sameUsageEvent(concurrent, data)) throw new UsageEventMismatchError()
        }
      },
      error => {
        if (error instanceof UsageEventMismatchError) return "event_mismatch" as const
        Logger.error("Failed to persist usage event for operation", error instanceof Error ? error.name : "non_error")
        return "unknown_error" as const
      }
    )
  }

  public persistBatch(
    context: TenantContext,
    data: CreateUsageEvent[]
  ): TE.TaskEither<UnknownError | "organization_mismatch", void> {
    if (data.length === 0) return TE.right(undefined)
    if (data.some(event => event.organizationId !== context.organizationId)) return TE.left("organization_mismatch")

    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.usageEvent.createMany({
          data: data.map(event => this.mapToPrisma(context, event))
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
    return TE.tryCatch(
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
    return TE.tryCatch(
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

        return groups.map(group => {
          const actorType: ActorType = group.actorType === "agent" ? "agent" : "user"
          return {
            actor: {
              id: group.actorId,
              type: actorType,
              displayName: group.actorDisplayName
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

  private mapToPrisma(
    context: TenantContext,
    data: CreateUsageEvent,
    id = uuidv7()
  ): Prisma.UsageEventUncheckedCreateInput {
    return {
      id,
      organizationId: context.organizationId,
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

function sameUsageEvent(
  existing: {
    readonly organizationId: string
    readonly entityType: string
    readonly entityId: string
    readonly actorType: string
    readonly actorId: string
    readonly actorDisplayName: string
    readonly metric: string
    readonly quantity: bigint
    readonly isBillable: boolean
    readonly metadata: Prisma.JsonValue | null
  },
  requested: CreateUsageEvent
): boolean {
  return (
    existing.organizationId === requested.organizationId &&
    existing.entityType === requested.entityType &&
    existing.entityId === requested.entityId &&
    existing.actorType === requested.actor.type &&
    existing.actorId === requested.actor.id &&
    existing.actorDisplayName === requested.actor.displayName &&
    existing.metric === requested.metric &&
    existing.quantity === requested.quantity &&
    existing.isBillable === requested.isBillable &&
    canonicalJson(existing.metadata) === canonicalJson(requested.metadata ?? null)
  )
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`
}

class UsageEventMismatchError extends Error {}
