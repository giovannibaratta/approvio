import {OrganizationSummaryFactory} from "../src/organization"
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
})
