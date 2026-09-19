import {WorkflowTemplateFactory, WorkflowTemplateStatus} from "../src/workflow-templates"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"

const timestamp = new Date()
const summary = {
  id: uuidv7(),
  organizationId: uuidv7(),
  name: "Summary template",
  version: 1,
  status: WorkflowTemplateStatus.ACTIVE,
  createdAt: timestamp,
  updatedAt: timestamp
}

describe("WorkflowTemplateSummary expiry", () => {
  it("accepts a summary without configured expiry", () => {
    expect(WorkflowTemplateFactory.validateSummary(summary)).toBeRight()
  })

  it("retains a valid configured expiry", () => {
    expect(WorkflowTemplateFactory.validateSummary({...summary, defaultExpiresInHours: 12})).toBeRightOf({
      ...summary,
      description: undefined,
      defaultExpiresInHours: 12
    })
  })

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid configured expiry %s", defaultExpiresInHours => {
    expect(WorkflowTemplateFactory.validateSummary({...summary, defaultExpiresInHours})).toBeLeftOf(
      "workflow_template_expires_in_hours_invalid"
    )
  })
})
