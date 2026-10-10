import {toOrganizationId} from "@test/organization-id"
import {WorkflowRecalculationProcessor} from "../src/processor/workflow-recalculation.processor"
import {WorkflowRecalculationService} from "@services/workflow/workflow-recalculation.service"
import {TenantEvent} from "@domain"
import * as TE from "fp-ts/TaskEither"

const event: TenantEvent = {
  organizationId: toOrganizationId("0198ed6b-0c41-7000-8000-000000000001"),
  schemaVersion: 1,
  eventId: "0198ed6b-0c41-7000-8000-000000000002",
  workflowId: "0198ed6b-0c41-7000-8000-000000000003",
  type: "workflow.recalculate"
}

describe("WorkflowRecalculationProcessor", () => {
  it("forwards tenant and event identity from the durable envelope", async () => {
    const recalculateWorkflowStatus = jest.fn(() => TE.right(undefined))
    const recalculation: Pick<WorkflowRecalculationService, "recalculateWorkflowStatus"> = {recalculateWorkflowStatus}
    const processor = new WorkflowRecalculationProcessor(recalculation)

    await processor.process({data: event, attemptsMade: 0, opts: {attempts: 3}, id: "job-1"})

    expect(recalculateWorkflowStatus).toHaveBeenCalledWith(event)
  })
})
