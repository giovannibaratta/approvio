import {WorkflowStatus} from "../src/workflows"
import {WorkflowActionType} from "../src/workflow-actions"
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
        type: "workflow.recalculate",
        workflowId: uuidv7()
      })
    ).toBeRight()
  })

  it("rejects an invalid organization ID", () => {
    expect(
      TenantEventFactory.validate({
        organizationId: "not-a-uuid",
        schemaVersion: 1,
        eventId: uuidv7(),
        type: "workflow.recalculate",
        workflowId: uuidv7()
      })
    ).toBeLeftOf("tenant_event_organization_id_invalid")
  })
  it("rejects the removed organization.resumed tenant event", () => {
    expect(
      TenantEventFactory.validate({
        organizationId: uuidv7(),
        schemaVersion: 1,
        eventId: uuidv7(),
        type: "organization.resumed"
      })
    ).toBeLeftOf("tenant_event_type_invalid")
  })
})

describe("TenantEventFactory native and serialized forms", () => {
  const base = {organizationId: uuidv7(), schemaVersion: 1, eventId: uuidv7()}

  it("produces the same task.ready event for bigint and string taskOcc values", () => {
    // Given
    const task = {...base, type: "task.ready", taskId: uuidv7(), taskKind: "email", taskOcc: 0n}

    // When
    const nativeTask = unwrapRight(TenantEventFactory.validate(task))
    const serializedTask = unwrapRight(TenantEventFactory.validate({...task, taskOcc: "0"}))

    // Expect
    expect(nativeTask).toEqual(serializedTask)
  })

  it("accepts a usage.settlement event with an operationId", () => {
    // Given
    const settlement = {...base, type: "usage.settlement", operationId: uuidv7()}

    // When
    const result = TenantEventFactory.validate(settlement)

    // Expect
    expect(result).toBeRightOf(settlement)
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
      workflowTemplateActions: [{type: WorkflowActionType.EMAIL, recipients: ["snapshot@example.com"]}],
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
    const emptySnapshot = TenantEventFactory.validate({...event, workflowTemplateActions: []})
    const missingSnapshot = TenantEventFactory.validate({...event, workflowTemplateActions: undefined})
    const malformedSnapshot = TenantEventFactory.validate({...event, workflowTemplateActions: [{}]})

    // Expect
    expect(unwrapRight(native)).toEqual(unwrapRight(serialized))
    expect(unwrapRight(native)).toMatchObject({workflowTemplateActions: event.workflowTemplateActions})
    expect(unwrapRight(emptySnapshot)).toMatchObject({workflowTemplateActions: []})
    expect(missingSnapshot).toBeLeftOf("tenant_event_workflow_actions_invalid")
    expect(malformedSnapshot).toBeLeftOf("tenant_event_workflow_actions_invalid")
    expect(invalid).toBeLeftOf("tenant_event_occurred_at_invalid")
  })
})
