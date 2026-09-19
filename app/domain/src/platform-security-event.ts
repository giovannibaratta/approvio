import {Either, isLeft, left, right} from "fp-ts/Either"
import {Brand, brand, isObject, isUUIDv7} from "@utils"
import {isOriginatingActor, OriginatingActor} from "./authenticated-entity"
import {SuspensionReason} from "./shared"

const PLATFORM_SECURITY_EVENT_REASON_MAX_LENGTH = 500

declare const _PlatformSecurityEventBrand: unique symbol

interface PlatformSecurityEventBase {
  readonly id: string
  readonly actor: OriginatingActor
  readonly occurredAt: Date
}

export type PlatformSecurityEventData =
  | (PlatformSecurityEventBase & {
      readonly type: "organization.bootstrapped"
      readonly organizationId: string
      readonly accountId: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.owner_restored"
      readonly organizationId: string
      readonly accountId: string
      readonly reason: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.suspended"
      readonly organizationId: string
      readonly reason: SuspensionReason
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.resumed"
      readonly organizationId: string
      readonly reason: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.grace_period_changed"
      readonly organizationId: string
      readonly dueAt: Date | null
      readonly reason: string
    })

export type PlatformSecurityEvent = Brand<PlatformSecurityEventData, typeof _PlatformSecurityEventBrand>

export type PlatformSecurityEventValidationError =
  | "platform_security_event_malformed"
  | "platform_security_event_invalid_id"
  | "platform_security_event_invalid_actor"
  | "platform_security_event_invalid_occurred_at"
  | "platform_security_event_invalid_organization_id"
  | "platform_security_event_invalid_account_id"
  | "platform_security_event_invalid_reason"
  | "platform_security_event_invalid_suspension_reason"
  | "platform_security_event_invalid_due_at"
  | "platform_security_event_invalid_type"

export class PlatformSecurityEventFactory {
  static validate(data: unknown): Either<PlatformSecurityEventValidationError, PlatformSecurityEvent> {
    if (!isObject(data)) return left("platform_security_event_malformed")
    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return left("platform_security_event_invalid_id")
    if (!isOriginatingActor(data.actor) || !isUUIDv7(data.actor.id) || data.actor.displayName.trim().length === 0)
      return left("platform_security_event_invalid_actor")
    if (!(data.occurredAt instanceof Date) || Number.isNaN(data.occurredAt.getTime()))
      return left("platform_security_event_invalid_occurred_at")

    const base = {id: data.id, actor: data.actor, occurredAt: data.occurredAt}
    const validatedEvent = validateEventVariant(data, base)
    if (isLeft(validatedEvent)) return validatedEvent
    return right(brand<PlatformSecurityEventData, typeof _PlatformSecurityEventBrand>(validatedEvent.right))
  }
}

function validateEventVariant(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isPlatformSecurityEventType(data.type)) return left("platform_security_event_invalid_type")

  switch (data.type) {
    case "organization.bootstrapped":
      return validateBootstrap(data, base)
    case "organization.owner_restored":
      return validateOwnerRestored(data, base)
    case "organization.suspended":
      return validateSuspension(data, base)
    case "organization.resumed":
      return validateResume(data, base)
    case "organization.grace_period_changed":
      return validateGracePeriodChange(data, base)
  }
}

type PlatformSecurityEventType = PlatformSecurityEventData["type"]

function isPlatformSecurityEventType(value: unknown): value is PlatformSecurityEventType {
  return (
    value === "organization.bootstrapped" ||
    value === "organization.owner_restored" ||
    value === "organization.suspended" ||
    value === "organization.resumed" ||
    value === "organization.grace_period_changed"
  )
}

function validateBootstrap(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isValidOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidAccountId(data.accountId)) return left("platform_security_event_invalid_account_id")
  return right({
    ...base,
    type: "organization.bootstrapped",
    organizationId: data.organizationId,
    accountId: data.accountId
  })
}

function validateOwnerRestored(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isValidOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidAccountId(data.accountId)) return left("platform_security_event_invalid_account_id")
  if (!isValidReason(data.reason)) return left("platform_security_event_invalid_reason")
  return right({
    ...base,
    type: "organization.owner_restored",
    organizationId: data.organizationId,
    accountId: data.accountId,
    reason: data.reason.trim()
  })
}

function validateSuspension(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isValidOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isSuspensionReason(data.reason)) return left("platform_security_event_invalid_suspension_reason")
  return right({...base, type: "organization.suspended", organizationId: data.organizationId, reason: data.reason})
}

function validateResume(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isValidOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidReason(data.reason)) return left("platform_security_event_invalid_reason")
  return right({...base, type: "organization.resumed", organizationId: data.organizationId, reason: data.reason.trim()})
}

function validateGracePeriodChange(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isValidOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidReason(data.reason)) return left("platform_security_event_invalid_reason")
  if (data.dueAt !== null && (!(data.dueAt instanceof Date) || Number.isNaN(data.dueAt.getTime())))
    return left("platform_security_event_invalid_due_at")
  return right({
    ...base,
    type: "organization.grace_period_changed",
    organizationId: data.organizationId,
    dueAt: data.dueAt,
    reason: data.reason.trim()
  })
}

function isValidOrganizationId(value: unknown): value is string {
  return typeof value === "string" && isUUIDv7(value)
}

function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && isUUIDv7(value)
}

function isValidReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= PLATFORM_SECURITY_EVENT_REASON_MAX_LENGTH
  )
}

function isSuspensionReason(value: unknown): value is SuspensionReason {
  return (
    value === "owner_requested" ||
    value === "security" ||
    value === "abuse" ||
    value === "payment" ||
    value === "operator"
  )
}
