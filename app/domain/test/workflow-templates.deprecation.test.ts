import {
  markTemplateForDeprecation,
  markTemplateAsDeprecated,
  WorkflowTemplateFactory,
  WorkflowTemplateStatus
} from "../src/workflow-templates"
import {ApprovalRuleType} from "../src/approval-rules"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

describe("WorkflowTemplate Deprecation", () => {
  const organizationId = uuidv7()
  const createActiveTemplate = (version: number = 1) => {
    return unwrapRight(
      WorkflowTemplateFactory.newWorkflowTemplate({
        organizationId,
        name: "Test Template",
        version,
        description: "Template used by lifecycle tests",
        approvalRule: {type: ApprovalRuleType.GROUP_REQUIREMENT, groupId: uuidv7(), minCount: 1},
        actions: [],
        defaultExpiresInHours: 24,
        spaceId: uuidv7()
      })
    )
  }

  describe("markTemplateForDeprecation", () => {
    it("should transition ACTIVE template to PENDING_DEPRECATION and keep the same version", () => {
      // Given: an active template with version 2
      const version = 2
      const template = createActiveTemplate(version)

      // When: markTemplateForDeprecation is called
      const result = markTemplateForDeprecation(template, false)

      // Expect: status is PENDING_DEPRECATION and version is still 2
      expect(result).toBeRightOf(
        expect.objectContaining({
          status: WorkflowTemplateStatus.PENDING_DEPRECATION,
          version: version,
          allowVotingOnDeprecatedTemplate: true
        })
      )
    })

    it("should set allowVotingOnDeprecatedTemplate correctly", () => {
      // Given: an active template
      const template = createActiveTemplate()

      // When: markTemplateForDeprecation is called with cancelWorkflows = true
      const result = markTemplateForDeprecation(template, true)

      // Expect: allowVotingOnDeprecatedTemplate is false
      expect(result).toBeRightOf(
        expect.objectContaining({
          allowVotingOnDeprecatedTemplate: false
        })
      )
    })

    it("should fail if template is not ACTIVE", () => {
      // Given: a template that is already PENDING_DEPRECATION
      const template = createActiveTemplate()
      const pendingResult = markTemplateForDeprecation(template, false)
      const pendingTemplate = unwrapRight(pendingResult)

      // When: markTemplateForDeprecation is called again
      const result = markTemplateForDeprecation(pendingTemplate, false)

      // Expect: error
      expect(result).toBeLeftOf("workflow_template_not_active")
    })
  })

  describe("markTemplateAsDeprecated", () => {
    it("should transition PENDING_DEPRECATION template to DEPRECATED", () => {
      // Given: a PENDING_DEPRECATION template
      const template = createActiveTemplate()
      const pendingResult = markTemplateForDeprecation(template, false)
      const pendingTemplate = unwrapRight(pendingResult)

      // When: markTemplateAsDeprecated is called
      const result = markTemplateAsDeprecated(pendingTemplate)

      // Expect: status is DEPRECATED
      expect(result).toBeRightOf(
        expect.objectContaining({
          status: WorkflowTemplateStatus.DEPRECATED
        })
      )
    })

    it("should fail if template is not PENDING_DEPRECATION", () => {
      // Given: an active template
      const template = createActiveTemplate()

      // When: markTemplateAsDeprecated is called
      const result = markTemplateAsDeprecated(template)

      // Expect: error
      expect(result).toBeLeftOf("workflow_template_not_pending_deprecation")
    })
  })
})
