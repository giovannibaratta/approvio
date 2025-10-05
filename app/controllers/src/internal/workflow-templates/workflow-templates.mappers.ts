import {generateErrorPayload} from "@controllers/error"
import {HttpException, ConflictException, InternalServerErrorException, NotFoundException} from "@nestjs/common"
import {WorkflowTemplateService} from "@services"
import {ExtractLeftFromMethod} from "@utils/types"

type CancelWorkflowsLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "cancelWorkflowsAndDeprecateTemplate">

export function generateErrorResponseForCancelWorkflowsForTemplate(
  error: CancelWorkflowsLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "max_attempts_reach_for_cancelling_workflows":
      return new ConflictException(
        generateErrorPayload(
          errorCode,
          `Unable to cancel all workflows for template after maximum attempts. Context: ${context}`
        )
      )

    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `Workflow template not found. Context: ${context}`))

    case "workflow_template_not_active":
    case "workflow_template_not_pending_deprecation":
    case "workflow_not_found":
    case "workflow_template_already_exists":
    case "workflow_template_name_empty":
    case "workflow_template_name_too_long":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_description_too_long":
    case "workflow_template_update_before_create":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_status_invalid":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_template_version_invalid_format":
    case "workflow_template_active_is_not_latest":
    case "approval_rule_malformed_content":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_or_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_max_rule_nesting_exceeded":
    case "workflow_action_type_invalid":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_name_empty":
    case "workflow_name_too_long":
    case "workflow_name_invalid_characters":
    case "workflow_description_too_long":
    case "workflow_update_before_create":
    case "workflow_status_invalid":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_expires_at_in_the_past":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `Internal data inconsistency. Context: ${context}`)
      )

    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `Concurrency error occurred while processing request. Context: ${context}`)
      )

    case "unknown_error":
      return new InternalServerErrorException(`An unknown error occurred. Context: ${context}`)
  }
}
