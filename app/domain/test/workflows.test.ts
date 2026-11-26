import {randomOrgId} from "@test/organization-id"
import {v7 as uuidv7} from "uuid"
import {WorkflowFactory} from "@domain"

describe("workflow domain", () => {
  it("rejects invalid workflow IDs during shared validation", () => {
    // Given
    const now = new Date()
    const obj = {
      id: "invalid-id",
      organizationId: randomOrgId(),
      name: "Test workflow",
      status: "EVALUATION_IN_PROGRESS",
      recalculationRequired: false,
      workflowTemplateId: uuidv7(),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }

    // When
    const result = WorkflowFactory.validate(obj)

    // Then
    expect(result).toBeLeftOf("workflow_id_invalid_uuid")
  })

  it("rejects invalid organization IDs during shared validation", () => {
    // Given
    const now = new Date()
    const obj = {
      id: uuidv7(),
      organizationId: "invalid-id",
      name: "Test workflow",
      status: "EVALUATION_IN_PROGRESS",
      recalculationRequired: false,
      workflowTemplateId: uuidv7(),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now
    }

    // When
    const result = WorkflowFactory.validate(obj)

    // Then
    expect(result).toBeLeftOf("workflow_organization_id_invalid_uuid")
  })
})
