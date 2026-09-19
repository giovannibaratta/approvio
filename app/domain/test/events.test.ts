import {WorkflowStatus} from "../src/workflows"
import {unwrapRight} from "@utils/either"
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

describe("TenantEventFactory native and serialized forms", () => {
  const base = {organizationId: uuidv7(), schemaVersion: 1, eventId: uuidv7()}

  // TODO: What does it mean serialization round trip ?
  it("validates native task and settlement versions without a serialization round trip", () => {
    // Given
    const task = {...base, type: "task.ready", taskId: uuidv7(), taskKind: "email", taskOcc: 0n}
    const settlement = {...base, type: "usage.settlement", operationId: uuidv7(), operationOcc: 1n}

    // When
    // TODO: you should first assert that is right. Also I believe we might have an helper to assert on a specific result
    const nativeTask = unwrapRight(TenantEventFactory.validate(task))
    const serializedTask = unwrapRight(TenantEventFactory.validate({...task, taskOcc: "0"}))
    const nativeSettlement = unwrapRight(TenantEventFactory.validate(settlement))
    const serializedSettlement = unwrapRight(TenantEventFactory.validate({...settlement, operationOcc: "1"}))

    // Expect
    expect(nativeTask).toEqual(serializedTask)
    expect(nativeSettlement).toEqual(serializedSettlement)
  })

  // TODO: cross domain framing leaking. Just say that it accepts a string iso value.
  it("validates native workflow dates and versions using the same rules as serialized events", () => {
    // Given
    const event = {
      ...base,
      type: "workflow.status_changed",
      workflowId: uuidv7(),
      workflowOcc: 1n,
      previousStatus: WorkflowStatus.EVALUATION_IN_PROGRESS,
      status: WorkflowStatus.APPROVED,
      actor: {type: "system", displayName: "Worker"},
      occurredAt: new Date()
    }
    // When
    const native = TenantEventFactory.validate(event)
    const serialized = TenantEventFactory.validate({
      ...event,
      workflowOcc: "1",
      occurredAt: event.occurredAt.toISOString()
    })
    const invalid = TenantEventFactory.validate({...event, occurredAt: new Date(NaN)})

    // Expect
    expect(unwrapRight(native)).toEqual(unwrapRight(serialized))
    expect(invalid).toBeLeftOf("tenant_event_occurred_at_invalid")
  })
})
