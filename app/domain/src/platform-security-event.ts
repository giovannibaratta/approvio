import {Either, isLeft, left, right} from "fp-ts/Either"
import {Brand, brand, isObject, isUUIDv7} from "@utils"
import {isOriginatingActor, OriginatingActor} from "./authenticated-entity"
import {SuspensionReason, OrganizationId, isOrganizationId} from "./shared"

const PLATFORM_SECURITY_EVENT_REASON_MAX_LENGTH = 500

declare const _PlatformSecurityEventBrand: unique symbol
declare const _OrganizationMetadataBrand: unique symbol
declare const _AccountMetadataBrand: unique symbol
declare const _GracePeriodMetadataBrand: unique symbol

interface OrganizationMetadataData {
  readonly organizationId: OrganizationId
}

interface AccountMetadataData extends OrganizationMetadataData {
  readonly accountId: string
}

interface GracePeriodMetadataData extends OrganizationMetadataData {
  readonly dueAt?: string
}

interface PlatformSecurityEventMetadataByType {
  readonly "organization.bootstrapped": Brand<AccountMetadataData, typeof _AccountMetadataBrand>
  readonly "organization.owner_restored": Brand<AccountMetadataData, typeof _AccountMetadataBrand>
  readonly "organization.suspended": Brand<OrganizationMetadataData, typeof _OrganizationMetadataBrand>
  readonly "organization.resumed": Brand<OrganizationMetadataData, typeof _OrganizationMetadataBrand>
  readonly "organization.grace_period_changed": Brand<GracePeriodMetadataData, typeof _GracePeriodMetadataBrand>
}

export type PlatformSecurityEventMetadata<TType extends PlatformSecurityEventType = PlatformSecurityEventType> =
  PlatformSecurityEventMetadataByType[TType]

interface PlatformSecurityEventBase {
  readonly id: string
  readonly actor: OriginatingActor
  readonly occurredAt: Date
}

type PlatformSecurityEventData =
  | (PlatformSecurityEventBase & {
      readonly type: "organization.bootstrapped"
      readonly organizationId: OrganizationId
      readonly accountId: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.owner_restored"
      readonly organizationId: OrganizationId
      readonly accountId: string
      readonly reason: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.suspended"
      readonly organizationId: OrganizationId
      readonly reason: SuspensionReason
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.resumed"
      readonly organizationId: OrganizationId
      readonly reason: string
    })
  | (PlatformSecurityEventBase & {
      readonly type: "organization.grace_period_changed"
      readonly organizationId: OrganizationId
      readonly dueAt?: Date
      readonly reason: string
    })

export type PlatformSecurityEvent<TType extends PlatformSecurityEventType = PlatformSecurityEventType> = Brand<
  Extract<PlatformSecurityEventData, {readonly type: TType}>,
  typeof _PlatformSecurityEventBrand
>

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

  static toMetadata<TEvent extends PlatformSecurityEvent>(event: TEvent): PlatformSecurityEventMetadata<TEvent["type"]>
  static toMetadata(event: PlatformSecurityEvent): PlatformSecurityEventMetadata {
    switch (event.type) {
      case "organization.bootstrapped":
      case "organization.owner_restored":
        return brand<AccountMetadataData, typeof _AccountMetadataBrand>({
          organizationId: event.organizationId,
          accountId: event.accountId
        })
      case "organization.suspended":
      case "organization.resumed":
        return brand<OrganizationMetadataData, typeof _OrganizationMetadataBrand>({
          organizationId: event.organizationId
        })
      case "organization.grace_period_changed":
        return brand<GracePeriodMetadataData, typeof _GracePeriodMetadataBrand>({
          organizationId: event.organizationId,
          ...(event.dueAt === undefined ? {} : {dueAt: event.dueAt.toISOString()})
        })
    }
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

export type PlatformSecurityEventType = PlatformSecurityEventData["type"]

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
  if (!isOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
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
  if (!isOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
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
  if (!isOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isSuspensionReason(data.reason)) return left("platform_security_event_invalid_suspension_reason")
  return right({
    ...base,
    type: "organization.suspended",
    organizationId: data.organizationId,
    reason: data.reason
  })
}

function validateResume(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidReason(data.reason)) return left("platform_security_event_invalid_reason")
  return right({
    ...base,
    type: "organization.resumed",
    organizationId: data.organizationId,
    reason: data.reason.trim()
  })
}

function validateGracePeriodChange(
  data: Record<string, unknown>,
  base: PlatformSecurityEventBase
): Either<PlatformSecurityEventValidationError, PlatformSecurityEventData> {
  if (!isOrganizationId(data.organizationId)) return left("platform_security_event_invalid_organization_id")
  if (!isValidReason(data.reason)) return left("platform_security_event_invalid_reason")
  if (data.dueAt !== undefined && (!(data.dueAt instanceof Date) || Number.isNaN(data.dueAt.getTime())))
    return left("platform_security_event_invalid_due_at")
  return right({
    ...base,
    type: "organization.grace_period_changed",
    organizationId: data.organizationId,
    dueAt: data.dueAt,
    reason: data.reason.trim()
  })
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
