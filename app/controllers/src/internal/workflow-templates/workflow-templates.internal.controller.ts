import {GetTenantContext} from "@app/auth"
import {TenantContext} from "@domain"
import {Controller, HttpCode, HttpStatus, Param, Post} from "@nestjs/common"
import {WorkflowTemplateService} from "@services"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {generateErrorResponseForCancelWorkflowsForTemplate} from "./workflow-templates.mappers"

export const WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT = "internal/o/:organizationId/workflow-template"

@Controller(WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT)
export class WorkflowTemplateInternalController {
  constructor(private readonly workflowTemplateService: WorkflowTemplateService) {}

  // TODO(long-term): Define worker authentication and trigger this internal flow from template deprecation.
  // The worker must carry an authorized organization scope; system actors do not currently have an HTTP auth path.
  @Post("/:templateId/cancel-workflows")
  @HttpCode(HttpStatus.OK)
  async cancelWorkflowsForTemplate(
    @Param("templateId") templateId: string,
    @GetTenantContext() context: TenantContext
  ): Promise<void> {
    const eitherResult = await pipe(
      templateId,
      TE.right,
      TE.chainW(id => this.workflowTemplateService.cancelWorkflowsAndDeprecateTemplate(context, id))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForCancelWorkflowsForTemplate(
        eitherResult.left,
        "Failed to cancel workflows for workflow template"
      )
  }
}
