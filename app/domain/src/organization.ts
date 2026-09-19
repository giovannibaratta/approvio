import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isObject, isUUIDv7} from "@utils"
import {SuspensionReason, TenantContext} from "./shared"

export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/
export const ORGANIZATION_DISPLAY_NAME_MAX_LENGTH = 255

declare const OrganizationBrand: unique symbol

interface OrganizationBaseData extends TenantContext {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ActiveOrganizationData extends OrganizationBaseData {
  readonly status: "active"
}

export interface SuspendedOrganizationData extends OrganizationBaseData {
  readonly status: "suspended"
  readonly suspensionReason: SuspensionReason
  /**
   * Optional operator-configured grace period deadline.
   *
   * When an organization is suspended (e.g. for billing or payment failure),
   * this timestamp defines the grace window during which members may resolve
   * the issue before automated data deletion or tombstoning proceeds.
   */
  readonly graceUntil?: Date
}

export interface DeletingOrganizationData extends OrganizationBaseData {
  readonly status: "deleting"
}

export interface DeletedOrganizationData extends OrganizationBaseData {
  readonly status: "deleted"
}

export type OrganizationData =
  ActiveOrganizationData | SuspendedOrganizationData | DeletingOrganizationData | DeletedOrganizationData

export type Organization = Brand<OrganizationData, typeof OrganizationBrand>
export type SuspendedOrganization = Brand<SuspendedOrganizationData, typeof OrganizationBrand>

export function isSuspendedOrganization(organization: Organization): organization is SuspendedOrganization {
  return organization.status === "suspended"
}

export type OrganizationValidationError =
  | "organization_malformed_object"
  | "organization_invalid_uuid"
  | "organization_id_mismatch"
  | "organization_slug_invalid"
  | "organization_display_name_empty"
  | "organization_display_name_too_long"
  | "organization_invalid_status"
  | "organization_status_reason_mismatch"
  | "organization_invalid_suspension_reason"
  | "organization_invalid_grace_until"
  | "organization_update_before_create"

export type OrganizationTransitionError = "organization_invalid_transition" | "organization_resume_not_permitted"

const SUSPENSION_REASONS: ReadonlyArray<SuspensionReason> = [
  "owner_requested",
  "security",
  "abuse",
  "payment",
  "operator"
]

export class OrganizationFactory {
  static validate(data: unknown): Either<OrganizationValidationError, Organization> {
    if (!isObject(data)) return left("organization_malformed_object")

    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return left("organization_invalid_uuid")
    if (data.organizationId !== data.id) return left("organization_id_mismatch")

    if (typeof data.slug !== "string" || !ORGANIZATION_SLUG_PATTERN.test(data.slug)) {
      return left("organization_slug_invalid")
    }

    if (typeof data.displayName !== "string") return left("organization_display_name_empty")
    const displayName = data.displayName.trim()
    if (!displayName) return left("organization_display_name_empty")
    if (displayName.length > ORGANIZATION_DISPLAY_NAME_MAX_LENGTH) {
      return left("organization_display_name_too_long")
    }

    if (!(data.createdAt instanceof Date) || !(data.updatedAt instanceof Date)) {
      return left("organization_malformed_object")
    }
    if (data.createdAt > data.updatedAt) return left("organization_update_before_create")

    const baseData: OrganizationBaseData = {
      id: data.id,
      organizationId: data.organizationId,
      slug: data.slug,
      displayName,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    }

    if (data.status === "active") {
      if (data.suspensionReason !== undefined && data.suspensionReason !== null) {
        return left("organization_status_reason_mismatch")
      }
      const activeData = {...baseData, status: "active" as const} satisfies ActiveOrganizationData
      return right(brand<OrganizationData, typeof OrganizationBrand>(activeData))
    }

    if (data.status === "suspended") {
      if (
        typeof data.suspensionReason !== "string" ||
        !SUSPENSION_REASONS.includes(data.suspensionReason as SuspensionReason)
      ) {
        return left("organization_invalid_suspension_reason")
      }
      let graceUntil: Date | undefined
      if (data.graceUntil !== undefined && data.graceUntil !== null) {
        if (!(data.graceUntil instanceof Date)) return left("organization_invalid_grace_until")
        graceUntil = data.graceUntil
      }
      const suspendedData = {
        ...baseData,
        status: "suspended" as const,
        suspensionReason: data.suspensionReason as SuspensionReason,
        ...(graceUntil ? {graceUntil} : {})
      } satisfies SuspendedOrganizationData
      return right(brand<OrganizationData, typeof OrganizationBrand>(suspendedData))
    }

    if (data.status === "deleting") {
      if (data.suspensionReason !== undefined && data.suspensionReason !== null) {
        return left("organization_status_reason_mismatch")
      }
      const deletingData = {...baseData, status: "deleting" as const} satisfies DeletingOrganizationData
      return right(brand<OrganizationData, typeof OrganizationBrand>(deletingData))
    }

    if (data.status === "deleted") {
      if (data.suspensionReason !== undefined && data.suspensionReason !== null) {
        return left("organization_status_reason_mismatch")
      }
      const deletedData = {...baseData, status: "deleted" as const} satisfies DeletedOrganizationData
      return right(brand<OrganizationData, typeof OrganizationBrand>(deletedData))
    }

    return left("organization_invalid_status")
  }

  static transition(
    organization: Organization,
    next:
      | {readonly status: "suspended"; readonly reason: SuspensionReason; readonly graceUntil?: Date}
      | {readonly status: "active"}
      | {readonly status: "deleting"},
    actor: "owner" | "operator"
  ): Either<OrganizationTransitionError | OrganizationValidationError, Organization> {
    const now = new Date()
    if (organization.status === "deleting" || organization.status === "deleted") {
      return left("organization_invalid_transition")
    }

    if (next.status === "suspended") {
      return OrganizationFactory.suspend(organization, next.reason, next.graceUntil, now)
    }

    if (next.status === "active") {
      return OrganizationFactory.resume(organization, actor, now)
    }

    return OrganizationFactory.beginDeletion(organization, now)
  }

  private static suspend(
    organization: Organization,
    reason: SuspensionReason,
    graceUntil: Date | undefined,
    now: Date
  ): Either<OrganizationTransitionError | OrganizationValidationError, Organization> {
    if (organization.status !== "active") return left("organization_invalid_transition")
    return OrganizationFactory.validate({
      id: organization.id,
      organizationId: organization.organizationId,
      slug: organization.slug,
      displayName: organization.displayName,
      status: "suspended",
      suspensionReason: reason,
      graceUntil,
      createdAt: organization.createdAt,
      updatedAt: now
    })
  }

  private static resume(
    organization: Organization,
    actor: "owner" | "operator",
    now: Date
  ): Either<OrganizationTransitionError | OrganizationValidationError, Organization> {
    if (organization.status !== "suspended") return left("organization_invalid_transition")
    if (actor === "owner" && organization.suspensionReason !== "owner_requested") {
      return left("organization_resume_not_permitted")
    }
    return OrganizationFactory.validate({
      id: organization.id,
      organizationId: organization.organizationId,
      slug: organization.slug,
      displayName: organization.displayName,
      status: "active",
      createdAt: organization.createdAt,
      updatedAt: now
    })
  }

  private static beginDeletion(
    organization: Organization,
    now: Date
  ): Either<OrganizationTransitionError | OrganizationValidationError, Organization> {
    return OrganizationFactory.validate({
      id: organization.id,
      organizationId: organization.organizationId,
      slug: organization.slug,
      displayName: organization.displayName,
      status: "deleting",
      createdAt: organization.createdAt,
      updatedAt: now
    })
  }
}
