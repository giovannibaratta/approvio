import {OrganizationId, isOrganizationId} from "./shared"
import {Either, left, right, isLeft} from "fp-ts/Either"
import {DistributiveOmit, PrefixUnion, isObject, hasOwnProperty, isDate} from "@utils"
import {v7 as uuidv7} from "uuid"
import {OriginatingActor} from "./authenticated-entity"
import {ActorType} from "./audit-log"
import {TierQuotaLimit} from "./tier"
import {generateDeterministicId} from "@utils"

/** Terminal outcomes are immutable; an operation settles or cancels once. */
export type UsageSettlementState =
  {readonly state: "settled"; readonly actualUnits: number} | {readonly state: "cancelled"}

export type UsageOperationState = {readonly state: "reserved"} | UsageSettlementState

// TODO: Better docstring
/** Reconstruct totals only from a complete immutable ledger matching the settled operations. */
export function reconstructUsageLedger(
  organizationId: OrganizationId,
  operations: ReadonlyArray<
    {
      readonly operationId: string
      readonly estimatedUnits: number
    } & UsageOperationState
  >,
  events: ReadonlyArray<{readonly id: string; readonly quantity: bigint}>
): Either<"operation_mismatch", number> {
  let reserved = 0
  const settled = new Map<string, number>()
  for (const operation of operations) {
    if (operation.state === "reserved") reserved += operation.estimatedUnits
    if (operation.state === "settled")
      settled.set(UsageEventFactory.getOperationEventId(organizationId, operation.operationId), operation.actualUnits)
  }
  // TODO: isSafeInteger is classified. If we started with safe, integer, why should it become unsage ?
  if (!Number.isSafeInteger(reserved) || events.length !== settled.size) return left("operation_mismatch")
  let consumed = 0
  for (const event of events) {
    if (Number(event.quantity) !== settled.get(event.id)) return left("operation_mismatch")
    // TODO: Please explain the rationale
    settled.delete(event.id)
    consumed += Number(event.quantity)
  }
  if (settled.size !== 0 || consumed < 0 || !Number.isSafeInteger(consumed + reserved))
    return left("operation_mismatch")
  return right(consumed)
}

export const UNLIMITED_QUOTA_SENTINEL = -1

export interface UsageEntity {
  readonly id: string
  readonly type: string
}

export type UsageMetric = "MAX_LLM_TOKENS_PER_MONTH" | "MAX_EVALUATIONS_PER_MONTH" | "MAX_CREDITS_PER_MONTH"

export const ALL_METERED_METRICS: readonly UsageMetric[] = [
  "MAX_LLM_TOKENS_PER_MONTH",
  "MAX_EVALUATIONS_PER_MONTH",
  "MAX_CREDITS_PER_MONTH"
]

export function isUsageMetric(metric: unknown): metric is UsageMetric {
  return (
    metric === "MAX_LLM_TOKENS_PER_MONTH" ||
    metric === "MAX_EVALUATIONS_PER_MONTH" ||
    metric === "MAX_CREDITS_PER_MONTH"
  )
}

export type MetricUnit = "tokens" | "evaluations" | "credits"

/**
 * Returns the unit of measure label associated with a specific usage metric.
 */
export function getMetricUnit(metric: UsageMetric): MetricUnit {
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
export function calculateRemainingQuota(limit: TierQuotaLimit, consumed: number, reserved: number): TierQuotaLimit {
  if (limit === "UNLIMITED") return "UNLIMITED"
  return Math.max(0, limit - consumed - reserved)
}

export interface UsageEvent {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly entityType: string
  readonly entityId: string
  readonly actor: OriginatingActor
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
  | "invalid_organization_id"
>

interface ValidatedRequiredFields {
  readonly id: string
  readonly organizationId: OrganizationId
  readonly entityType: string
  readonly entityId: string
  readonly isBillable: boolean
  readonly occurredAt: Date
}

export class UsageEventFactory {
  /** Stable ledger identity shared by operation settlement and cache reconstruction. */
  static getOperationEventId(organizationId: OrganizationId, operationId: string): string {
    return generateDeterministicId(`usage-event-${organizationId}-${operationId}`)
  }

  /** Compare immutable billing facts; retries may supply a new timestamp for the same operation. */
  static isSameOperationEvent(existing: UsageEvent, requested: UsageEvent): boolean {
    return (
      existing.id === requested.id &&
      existing.organizationId === requested.organizationId &&
      existing.entityType === requested.entityType &&
      existing.entityId === requested.entityId &&
      existing.actor.type === requested.actor.type &&
      existing.actor.id === requested.actor.id &&
      existing.actor.displayName === requested.actor.displayName &&
      existing.metric === requested.metric &&
      existing.quantity === requested.quantity &&
      existing.isBillable === requested.isBillable &&
      canonicalJson(existing.metadata ?? null) === canonicalJson(requested.metadata ?? null)
    )
  }

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
      organizationId: requiredCheck.right.organizationId,
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
      !hasOwnProperty(data, "organizationId") ||
      !hasOwnProperty(data, "entityType") ||
      !hasOwnProperty(data, "entityId") ||
      !hasOwnProperty(data, "isBillable") ||
      !hasOwnProperty(data, "occurredAt")
    )
      return left("usage_event_missing_required_fields")

    const {id, organizationId, entityType, entityId, isBillable, occurredAt} = data

    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof organizationId !== "string" ||
      typeof entityId !== "string" ||
      entityId.trim() === "" ||
      typeof isBillable !== "boolean" ||
      !isDate(occurredAt) ||
      isNaN(occurredAt.getTime())
    )
      return left("usage_event_missing_required_fields")

    if (typeof entityType !== "string" || entityType.trim() === "") return left("usage_event_invalid_entity_type")
    if (!isOrganizationId(organizationId)) return left("usage_event_invalid_organization_id")

    return right({
      id,
      organizationId,
      entityType,
      entityId,
      isBillable,
      occurredAt
    })
  }

  private static validateActor(actor: unknown): Either<UsageEventValidationError, OriginatingActor> {
    if (
      !isObject(actor) ||
      !hasOwnProperty(actor, "id") ||
      !hasOwnProperty(actor, "type") ||
      !hasOwnProperty(actor, "displayName")
    )
      return left("usage_event_missing_required_fields")

    const {id, type, displayName} = actor

    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      typeof type !== "string" ||
      typeof displayName !== "string" ||
      !displayName.trim()
    )
      return left("usage_event_missing_required_fields")

    if (type !== "user" && type !== "agent" && type !== "operator") return left("usage_event_invalid_actor_type")

    const actorType: ActorType = type

    return right({id, type: actorType, displayName})
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`
}
