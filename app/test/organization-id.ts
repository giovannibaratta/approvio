import {v7 as uuidv7} from "uuid"
import {isOrganizationId, OrganizationId} from "@domain"

export function toOrganizationId(value: string): OrganizationId {
  if (!isOrganizationId(value)) throw new Error("Test organization ID must be a valid UUIDv7")
  return value
}

export function randomOrgId(): OrganizationId {
  return toOrganizationId(uuidv7())
}
