import {Either, left, right} from "fp-ts/Either"
import {isUUIDv7} from "@utils"
import {OrgStatus, SuspensionReason, TenantContext} from "./shared"

export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/
export const ORGANIZATION_DISPLAY_NAME_MAX_LENGTH = 255

// TODO: Why not using a discriminated union based on the status ?
export interface Organization extends TenantContext {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly status: OrgStatus
  // TODO: why using null instead of undefined ?
  readonly suspensionReason: SuspensionReason | null
  readonly graceUntil: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type OrganizationValidationError =
  | "organization_invalid_uuid"
  | "organization_id_mismatch"
  | "organization_slug_invalid"
  | "organization_display_name_empty"
  | "organization_display_name_too_long"
  | "organization_status_reason_mismatch"
  | "organization_update_before_create"

export type OrganizationTransitionError = "organization_invalid_transition" | "organization_resume_not_permitted"

export class OrganizationFactory {
  // TODO: why organization is not typed as object like all other validators ? If not typed object, the
  // persistence layer must construct it and is more error prone to do so.
  static validate(organization: Organization): Either<OrganizationValidationError, Organization> {
    if (!isUUIDv7(organization.id)) return left("organization_invalid_uuid")
    if (organization.organizationId !== organization.id) return left("organization_id_mismatch")
    if (!ORGANIZATION_SLUG_PATTERN.test(organization.slug)) return left("organization_slug_invalid")
    if (!organization.displayName.trim()) return left("organization_display_name_empty")
    if (organization.displayName.length > ORGANIZATION_DISPLAY_NAME_MAX_LENGTH)
      return left("organization_display_name_too_long")
    if (organization.createdAt > organization.updatedAt) return left("organization_update_before_create")
    if ((organization.status === "suspended") !== (organization.suspensionReason !== null))
      return left("organization_status_reason_mismatch")

    return right(organization)
  }

  static transition(
    organization: Organization,
    next:
      | {readonly status: "suspended"; readonly reason: SuspensionReason}
      | {readonly status: "active"}
      | {readonly status: "deleting"},
    actor: "owner" | "operator",
    // TODO: Why do we need the now attribute ?
    now: Date = new Date()
  ): Either<OrganizationTransitionError | OrganizationValidationError, Organization> {
    if (organization.status === "deleting" || organization.status === "deleted")
      return left("organization_invalid_transition")

    // TODO: These can be break down if private helpers
    if (next.status === "suspended") {
      if (organization.status !== "active") return left("organization_invalid_transition")
      return OrganizationFactory.validate({
        ...organization,
        status: "suspended",
        suspensionReason: next.reason,
        updatedAt: now
      })
    }

    if (next.status === "active") {
      if (organization.status !== "suspended") return left("organization_invalid_transition")
      // TODO: if might be better and safer to have a dedicated attribute tracking if the
      // suspension for platform enforced or owner enforced instead of relying on the reason.
      if (actor === "owner" && organization.suspensionReason !== "owner_requested")
        return left("organization_resume_not_permitted")
      return OrganizationFactory.validate({
        ...organization,
        status: "active",
        suspensionReason: null,
        updatedAt: now
      })
    }

    return OrganizationFactory.validate({
      ...organization,
      status: "deleting",
      suspensionReason: null,
      updatedAt: now
    })
  }
}
