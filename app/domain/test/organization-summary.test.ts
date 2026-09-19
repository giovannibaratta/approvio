import {ORGANIZATION_DISPLAY_NAME_MAX_LENGTH, OrganizationSummaryFactory} from "../src/organization"
import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"

describe("OrganizationSummaryFactory", () => {
  const validSummary = {
    id: uuidv7(),
    slug: "acme-org",
    displayName: "Acme Organization",
    status: "active",
    occ: 0n
  }

  it("brands a valid UUIDv7 string while validating the summary model", () => {
    expect(OrganizationSummaryFactory.validate(validSummary)).toBeRight()
  })

  it("rejects an invalid organization ID", () => {
    expect(OrganizationSummaryFactory.validate({...validSummary, id: "not-a-uuid"})).toBeLeftOf(
      "organization_summary_invalid_id"
    )
  })

  it("rejects an unknown organization status", () => {
    expect(OrganizationSummaryFactory.validate({...validSummary, status: "archived"})).toBeLeftOf(
      "organization_summary_invalid_status"
    )
  })

  it("normalizes a display name at the maximum length", () => {
    const displayName = "a".repeat(ORGANIZATION_DISPLAY_NAME_MAX_LENGTH)
    expect(OrganizationSummaryFactory.validate({...validSummary, displayName: `  ${displayName}  `})).toBeRightOf({
      ...validSummary,
      displayName
    })
  })

  it("rejects a display name beyond the maximum length", () => {
    const displayName = "a".repeat(ORGANIZATION_DISPLAY_NAME_MAX_LENGTH + 1)
    expect(OrganizationSummaryFactory.validate({...validSummary, displayName})).toBeLeftOf(
      "organization_summary_invalid_display_name"
    )
  })

  it("rejects a whitespace-only display name", () => {
    expect(OrganizationSummaryFactory.validate({...validSummary, displayName: "   "})).toBeLeftOf(
      "organization_summary_invalid_display_name"
    )
  })

  it("allows renaming an active organization", () => {
    // Given
    const validated = OrganizationSummaryFactory.validate(validSummary)
    const organization = unwrapRight(validated)

    // When
    const renamed = OrganizationSummaryFactory.updateDisplayName(organization, "Renamed")

    // Expect
    expect(renamed).toBeRightOf({...organization, displayName: "Renamed"})
  })

  it.each(["suspended", "deleting", "deleted"] as const)("rejects renaming a %s organization", status => {
    // Given
    const validated = OrganizationSummaryFactory.validate({...validSummary, status})
    const organization = unwrapRight(validated)

    // When
    const renamed = OrganizationSummaryFactory.updateDisplayName(organization, "Renamed")

    // Expect
    expect(renamed).toBeLeftOf("invalid_transition")
  })

  it("validates the new display name through the summary factory", () => {
    // Given
    const validated = OrganizationSummaryFactory.validate(validSummary)
    const organization = unwrapRight(validated)

    // When
    const renamed = OrganizationSummaryFactory.updateDisplayName(organization, "  ")

    // Expect
    expect(renamed).toBeLeftOf("organization_summary_invalid_display_name")
  })
})
