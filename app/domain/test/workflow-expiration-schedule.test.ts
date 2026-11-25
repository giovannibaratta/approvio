import {WorkflowExpirationScheduleFactory} from "../src/workflow-expiration-schedule"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("WorkflowExpirationScheduleFactory", () => {
  it("validates a schedule that has never been swept", () => {
    // Given
    const organizationId = randomOrgId()

    // When
    const schedule = unwrapRight(WorkflowExpirationScheduleFactory.validate({organizationId}))

    // Expect
    expect(schedule.organizationId).toBe(organizationId)
    expect(schedule.lastSweptAt).toBeUndefined()
  })

  it("validates an existing sweep timestamp", () => {
    // Given
    const data = {organizationId: randomOrgId(), lastSweptAt: new Date("2026-01-01T00:00:00Z")}

    // When
    const schedule = unwrapRight(WorkflowExpirationScheduleFactory.validate(data))

    // Expect
    expect(schedule).toEqual(data)
  })

  it.each([null, undefined, [], "schedule"])("rejects a malformed object: %s", data => {
    // When
    const result = WorkflowExpirationScheduleFactory.validate(data)

    // Expect
    expect(result).toBeLeftOf("workflow_expiration_schedule_malformed_object")
  })

  it("rejects an invalid organization ID", () => {
    // When
    const result = WorkflowExpirationScheduleFactory.validate({organizationId: "invalid"})

    // Expect
    expect(result).toBeLeftOf("workflow_expiration_schedule_invalid_organization_id")
  })

  it.each([null, "2026-01-01", 0, new Date(NaN)])("rejects an invalid sweep timestamp: %s", lastSweptAt => {
    // Given
    const data = {organizationId: randomOrgId(), lastSweptAt}

    // When
    const result = WorkflowExpirationScheduleFactory.validate(data)

    // Expect
    expect(result).toBeLeftOf("workflow_expiration_schedule_invalid_last_swept_at")
  })
})
