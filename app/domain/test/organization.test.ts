import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"
import {
  isSuspendedOrganization,
  OrganizationFactory,
  SuspendedOrganization
} from "../src/organization"

describe("OrganizationFactory", () => {
  const validId = uuidv7()
  const validDate = new Date("2026-01-01T00:00:00.000Z")

  const createValidActiveOrgData = () => ({
    id: validId,
    organizationId: validId,
    slug: "acme-corp",
    displayName: "Acme Corp",
    status: "active" as const,
    createdAt: validDate,
    updatedAt: validDate
  })

  describe("validate", () => {
    it("validates and brands active organization with trimmed displayName", () => {
      const data = {...createValidActiveOrgData(), displayName: "  Acme Corp  "}
      const result = OrganizationFactory.validate(data)

      expect(result).toBeRight()
      const org = unwrapRight(result)
      expect(org.id).toBe(validId)
      expect(org.organizationId).toBe(validId)
      expect(org.slug).toBe("acme-corp")
      expect(org.displayName).toBe("Acme Corp")
      expect(org.status).toBe("active")
    })

    it("validates suspended organization with suspensionReason and optional graceUntil", () => {
      const graceUntil = new Date("2026-02-01T00:00:00.000Z")
      const data = {
        ...createValidActiveOrgData(),
        status: "suspended",
        suspensionReason: "security",
        graceUntil
      }
      const result = OrganizationFactory.validate(data)

      expect(result).toBeRight()
      const org = unwrapRight(result)
      expect(isSuspendedOrganization(org)).toBe(true)
      const suspendedOrg = org as SuspendedOrganization
      expect(suspendedOrg.suspensionReason).toBe("security")
      expect(suspendedOrg.graceUntil).toEqual(graceUntil)
    })

    it("fails when input is not an object", () => {
      expect(OrganizationFactory.validate(null)).toBeLeftOf("organization_malformed_object")
      expect(OrganizationFactory.validate(undefined)).toBeLeftOf("organization_malformed_object")
      expect(OrganizationFactory.validate("string")).toBeLeftOf("organization_malformed_object")
    })

    it("fails on invalid UUID id", () => {
      const data = {...createValidActiveOrgData(), id: "not-a-uuid", organizationId: "not-a-uuid"}
      expect(OrganizationFactory.validate(data)).toBeLeftOf("organization_invalid_uuid")
    })

    it("fails on organizationId mismatch with id", () => {
      const data = {...createValidActiveOrgData(), organizationId: uuidv7()}
      expect(OrganizationFactory.validate(data)).toBeLeftOf("organization_id_mismatch")
    })

    it("fails on invalid slug format", () => {
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), slug: "-invalid"})).toBeLeftOf(
        "organization_slug_invalid"
      )
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), slug: "INVALID_UPPERCASE"})).toBeLeftOf(
        "organization_slug_invalid"
      )
    })

    it("fails on empty or whitespace displayName", () => {
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), displayName: ""})).toBeLeftOf(
        "organization_display_name_empty"
      )
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), displayName: "   "})).toBeLeftOf(
        "organization_display_name_empty"
      )
    })

    it("fails on overly long displayName", () => {
      const longName = "a".repeat(256)
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), displayName: longName})).toBeLeftOf(
        "organization_display_name_too_long"
      )
    })

    it("fails when non-suspended organization has suspensionReason", () => {
      const data = {...createValidActiveOrgData(), suspensionReason: "security"}
      expect(OrganizationFactory.validate(data)).toBeLeftOf("organization_status_reason_mismatch")
    })

    it("fails when suspended organization has missing or invalid suspensionReason", () => {
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), status: "suspended"})).toBeLeftOf(
        "organization_invalid_suspension_reason"
      )
      expect(
        OrganizationFactory.validate({
          ...createValidActiveOrgData(),
          status: "suspended",
          suspensionReason: "non_existent_reason"
        })
      ).toBeLeftOf("organization_invalid_suspension_reason")
    })

    it("fails when suspended organization has invalid graceUntil type", () => {
      expect(
        OrganizationFactory.validate({
          ...createValidActiveOrgData(),
          status: "suspended",
          suspensionReason: "security",
          graceUntil: "2026-02-01"
        })
      ).toBeLeftOf("organization_invalid_grace_until")
    })

    it("fails on invalid dates or updatedAt before createdAt", () => {
      expect(OrganizationFactory.validate({...createValidActiveOrgData(), createdAt: "2026-01-01"})).toBeLeftOf(
        "organization_malformed_object"
      )
      expect(
        OrganizationFactory.validate({
          ...createValidActiveOrgData(),
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      ).toBeLeftOf("organization_update_before_create")
    })
  })

  describe("transition", () => {
    it("transitions from active to suspended and back to active by operator", () => {
      const org = unwrapRight(OrganizationFactory.validate(createValidActiveOrgData()))
      const suspended = unwrapRight(
        OrganizationFactory.transition(org, {status: "suspended", reason: "payment"}, "operator")
      )
      expect(suspended.status).toBe("suspended")

      const resumed = unwrapRight(OrganizationFactory.transition(suspended, {status: "active"}, "operator"))
      expect(resumed.status).toBe("active")
    })

    it("transitions from active to deleting", () => {
      const org = unwrapRight(OrganizationFactory.validate(createValidActiveOrgData()))
      const deleting = unwrapRight(OrganizationFactory.transition(org, {status: "deleting"}, "owner"))
      expect(deleting.status).toBe("deleting")
    })

    it("rejects transitions from deleting or deleted", () => {
      const org = unwrapRight(
        OrganizationFactory.validate({...createValidActiveOrgData(), status: "deleting"})
      )
      expect(OrganizationFactory.transition(org, {status: "active"}, "operator")).toBeLeftOf(
        "organization_invalid_transition"
      )
    })
  })
})
