import {Either, left, right, isLeft} from "fp-ts/Either"
import {DistributiveOmit, PrefixUnion, isObject, hasOwnProperty, isDate} from "@utils"
import {v7 as uuidv7} from "uuid"
import {Actor, ActorType} from "./audit-log"
import {TierQuotaLimit} from "./tier"

export const UNLIMITED_QUOTA_SENTINEL = -1

export interface UsageEntity {
  readonly id: string
  readonly type: string
}

export type UsageMetric = "MAX_LLM_TOKENS_PER_MONTH" | "MAX_EVALUATIONS_PER_MONTH" | "MAX_CREDITS_PER_MONTH"

export function isUsageMetric(metric: unknown): metric is UsageMetric {
  return (
    metric === "MAX_LLM_TOKENS_PER_MONTH" ||
    metric === "MAX_EVALUATIONS_PER_MONTH" ||
    metric === "MAX_CREDITS_PER_MONTH"
  )
}

/**
 * Returns the unit of measure label associated with a specific usage metric.
 */
export function getMetricUnit(metric: UsageMetric): string {
  switch (metric) {
    case "MAX_LLM_TOKENS_PER_MONTH":
      return "tokens"
    case "MAX_EVALUATIONS_PER_MONTH":
      return "evaluations"
    case "MAX_CREDITS_PER_MONTH":
      return "credits"
  }
}

/**
 * Calculates the remaining quota capacity given a limit, total consumed, and active reservations.
 */
export function calculateRemainingQuota(
  limit: TierQuotaLimit,
  consumed: number,
  reserved: number
): TierQuotaLimit {
  if (limit === "UNLIMITED") return "UNLIMITED"
  return Math.max(0, limit - consumed - reserved)
}

export interface UsageEvent {
  readonly id: string
  readonly entityType: string
  readonly entityId: string
  readonly actor: Actor
  readonly metric: UsageMetric
  readonly quantity: bigint
  readonly isBillable: boolean
  readonly occurredAt: Date
  readonly metadata?: Record<string, unknown> | null
}

export type CreateUsageEvent = DistributiveOmit<UsageEvent, "id">

export type UsageEventValidationError = PrefixUnion<
  "usage_event",
  | "malformed_object"
  | "missing_required_fields"
  | "invalid_entity_type"
  | "invalid_actor_type"
  | "invalid_metric"
  | "invalid_quantity"
>

interface ValidatedRequiredFields {
  readonly id: string
  readonly entityType: string
  readonly entityId: string
  readonly isBillable: boolean
  readonly occurredAt: Date
}

export class UsageEventFactory {
  static create(
    data: DistributiveOmit<CreateUsageEvent, "occurredAt"> & {occurredAt?: Date}
  ): Either<UsageEventValidationError, UsageEvent> {
    const {occurredAt, ...rest} = data
    const usageEvent = {
      id: uuidv7(),
      occurredAt: occurredAt ?? new Date(),
      ...rest
    }
    return UsageEventFactory.validate(usageEvent)
  }

  static validate(data: unknown): Either<UsageEventValidationError, UsageEvent> {
    if (!isObject(data)) return left("usage_event_malformed_object")

    const requiredCheck = UsageEventFactory.validateRequiredFields(data)
    if (isLeft(requiredCheck)) return requiredCheck

    if (!hasOwnProperty(data, "actor")) return left("usage_event_missing_required_fields")
    const actorCheck = UsageEventFactory.validateActor(data.actor)
    if (isLeft(actorCheck)) return actorCheck

    if (!hasOwnProperty(data, "metric")) return left("usage_event_missing_required_fields")
    const metricCheck = UsageEventFactory.validateMetric(data.metric)
    if (isLeft(metricCheck)) return metricCheck

    if (!hasOwnProperty(data, "quantity") || typeof data.quantity !== "bigint" || data.quantity < 0n)
      return left("usage_event_invalid_quantity")

    const metadataCheck = UsageEventFactory.validateMetadata(data)
    if (isLeft(metadataCheck)) return metadataCheck

    const validatedEvent: UsageEvent = {
      id: requiredCheck.right.id,
      entityType: requiredCheck.right.entityType,
      entityId: requiredCheck.right.entityId,
      actor: actorCheck.right,
      metric: metricCheck.right,
      quantity: data.quantity,
      isBillable: requiredCheck.right.isBillable,
      occurredAt: requiredCheck.right.occurredAt,
      ...(metadataCheck.right !== undefined && {metadata: metadataCheck.right})
    }

    return right(validatedEvent)
  }

  private static validateRequiredFields(
    data: Record<string, unknown>
  ): Either<UsageEventValidationError, ValidatedRequiredFields> {
    if (
      !hasOwnProperty(data, "id") ||
      !hasOwnProperty(data, "entityType") ||
      !hasOwnProperty(data, "entityId") ||
      !hasOwnProperty(data, "isBillable") ||
      !hasOwnProperty(data, "occurredAt")
    )
      return left("usage_event_missing_required_fields")

    const {id, entityType, entityId, isBillable, occurredAt} = data

    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof entityId !== "string" ||
      entityId.trim() === "" ||
      typeof isBillable !== "boolean" ||
      !isDate(occurredAt) ||
      isNaN(occurredAt.getTime())
    )
      return left("usage_event_missing_required_fields")

    if (typeof entityType !== "string" || entityType.trim() === "") return left("usage_event_invalid_entity_type")

    return right({
      id,
      entityType,
      entityId,
      isBillable,
      occurredAt
    })
  }

  private static validateActor(actor: unknown): Either<UsageEventValidationError, Actor> {
    if (!isObject(actor) || !hasOwnProperty(actor, "id") || !hasOwnProperty(actor, "type"))
      return left("usage_event_missing_required_fields")

    const {id, type} = actor

    if (typeof id !== "string" || id.trim() === "" || typeof type !== "string")
      return left("usage_event_missing_required_fields")

    if (type !== "user" && type !== "agent") return left("usage_event_invalid_actor_type")

    const actorType: ActorType = type

    return right({id, type: actorType})
  }

  private static validateMetric(metric: unknown): Either<UsageEventValidationError, UsageMetric> {
    if (typeof metric !== "string") return left("usage_event_missing_required_fields")

    if (!isUsageMetric(metric)) return left("usage_event_invalid_metric")

    return right(metric)
  }

  private static validateMetadata(
    data: Record<string, unknown>
  ): Either<UsageEventValidationError, Record<string, unknown> | null | undefined> {
    if (!hasOwnProperty(data, "metadata") || data.metadata === undefined) return right(undefined)
    if (data.metadata === null) return right(null)
    if (isObject(data.metadata)) return right(data.metadata)
    return left("usage_event_malformed_object")
  }
}
