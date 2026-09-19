import {TenantEventFactory} from "../src/events"
import {v7 as uuidv7} from "uuid"

describe("TenantEventFactory", () => {
  it("validates a tenant event and brands its organization ID", () => {
    expect(
      TenantEventFactory.validate({
        organizationId: uuidv7(),
        schemaVersion: 1,
        eventId: uuidv7(),
        type: "organization.resumed"
      })
    ).toBeRight()
  })

  it("rejects an invalid organization ID", () => {
    expect(
      TenantEventFactory.validate({
        organizationId: "not-a-uuid",
        schemaVersion: 1,
        eventId: uuidv7(),
        type: "organization.resumed"
      })
    ).toBeLeftOf("tenant_event_organization_id_invalid")
  })
})
