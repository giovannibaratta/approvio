import {Controller, HttpCode, HttpStatus, Param, Post} from "@nestjs/common"
import {WorkflowTemplateService} from "@services"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {generateErrorResponseForCancelWorkflowsForTemplate} from "./workflow-templates.mappers"

export const WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT = "internal/workflow-template"

@Controller(WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT)
export class WorkflowTemplateInternalController {
  constructor(private readonly workflowTemplateService: WorkflowTemplateService) {}

  @Post("/:templateId/cancel-workflows")
  @HttpCode(HttpStatus.OK)
  async cancelWorkflowsForTemplate(@Param("templateId") templateId: string): Promise<void> {
    const eitherResult = await pipe(
      templateId,
      TE.right,
      TE.chainW(id => this.workflowTemplateService.cancelWorkflowsAndDeprecateTemplate(id))
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForCancelWorkflowsForTemplate(
        eitherResult.left,
        "Failed to cancel workflows for workflow template"
      )
    }
  }
}
