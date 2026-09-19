import {ORGANIZATION_DISPLAY_NAME_MAX_LENGTH, OrganizationSummaryFactory} from "../src/organization"
import {v7 as uuidv7} from "uuid"

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
})
