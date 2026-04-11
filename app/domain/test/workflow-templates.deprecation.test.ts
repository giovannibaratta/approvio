import {markTemplateForDeprecation, markTemplateAsDeprecated, WorkflowTemplateStatus} from "../src/workflow-templates"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"
import {createMockWorkflowTemplateDomain} from "@test/mock-data"

describe("WorkflowTemplate Deprecation", () => {
  const createActiveTemplate = (version: number = 1) => {
    return createMockWorkflowTemplateDomain({version, status: WorkflowTemplateStatus.ACTIVE})
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
