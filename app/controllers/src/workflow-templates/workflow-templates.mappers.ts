import {
  WorkflowTemplateCreate as WorkflowTemplateCreateApi,
  WorkflowTemplateUpdate as WorkflowTemplateUpdateApi,
  WorkflowAction as WorkflowActionApi,
  WorkflowTemplate as WorkflowTemplateApi,
  WorkflowTemplateSummary as WorkflowTemplateSummaryApi,
  ApprovalRule as ApprovalRuleApi,
  ListWorkflowTemplates200Response
} from "@approvio/api"
import {generateErrorPayload} from "@controllers/error"
import {mapApprovalRuleDataToApi} from "@controllers/shared"
import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  ApprovalRule,
  ApprovalRuleValidationError,
  ApprovalRuleFactory,
  WorkflowAction,
  WorkflowActionType,
  WorkflowTemplateSummary,
  AuthenticatedEntity
} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from "@nestjs/common"
import {
  CreateWorkflowTemplateRequest,
  ListWorkflowTemplatesResponse,
  UpdateWorkflowTemplateRequest,
  WorkflowTemplateService
} from "@services"
import {ExtractLeftFromMethod} from "@utils"
import {Either, isLeft, right} from "fp-ts/Either"

export function createWorkflowTemplateApiToServiceModel(data: {
  workflowTemplateData: WorkflowTemplateCreateApi
  requestor: AuthenticatedEntity
}): Either<ApprovalRuleValidationError | WorkflowTemplateValidationError, CreateWorkflowTemplateRequest> {
  const eitherApprovalRule = mapApprovalRuleToDomain(data.workflowTemplateData.approvalRule)
  if (isLeft(eitherApprovalRule)) return eitherApprovalRule

  const workflowTemplateData: CreateWorkflowTemplateRequest["workflowTemplateData"] = {
    name: data.workflowTemplateData.name,
    description: data.workflowTemplateData.description,
    approvalRule: eitherApprovalRule.right,
    actions: data.workflowTemplateData.actions,
    defaultExpiresInHours: data.workflowTemplateData.defaultExpiresInHours,
    spaceId: data.workflowTemplateData.spaceId
  }

  return right({
    workflowTemplateData,
    requestor: data.requestor
  })
}

export function updateWorkflowTemplateApiToServiceModel(data: {
  templateName: string
  workflowTemplateData: WorkflowTemplateUpdateApi
  requestor: AuthenticatedEntity
}): Either<ApprovalRuleValidationError | WorkflowTemplateValidationError, UpdateWorkflowTemplateRequest> {
  let approvalRule: ApprovalRule | undefined = undefined

  if (data.workflowTemplateData.approvalRule !== undefined) {
    const eitherApprovalRule = mapApprovalRuleToDomain(data.workflowTemplateData.approvalRule)
    if (isLeft(eitherApprovalRule)) return eitherApprovalRule
    approvalRule = eitherApprovalRule.right
  }

  const workflowTemplateData: UpdateWorkflowTemplateRequest["workflowTemplateData"] = {}

  if (data.workflowTemplateData.description !== undefined)
    workflowTemplateData.description = data.workflowTemplateData.description

  if (approvalRule !== undefined) workflowTemplateData.approvalRule = approvalRule

  if (data.workflowTemplateData.actions !== undefined) workflowTemplateData.actions = data.workflowTemplateData.actions

  if (data.workflowTemplateData.defaultExpiresInHours !== undefined)
    workflowTemplateData.defaultExpiresInHours = data.workflowTemplateData.defaultExpiresInHours

  return right({
    templateName: data.templateName,
    workflowTemplateData,
    cancelWorkflows: data.workflowTemplateData.cancelWorkflows,
    requestor: data.requestor
  })
}

function mapApprovalRuleToDomain(apiRule: ApprovalRuleApi): Either<ApprovalRuleValidationError, ApprovalRule> {
  return ApprovalRuleFactory.validate(apiRule)
}

export function mapWorkflowTemplateToApi(workflowTemplate: WorkflowTemplate): WorkflowTemplateApi {
  return {
    id: workflowTemplate.id,
    name: workflowTemplate.name,
    version: workflowTemplate.version.toString(),
    description: workflowTemplate.description,
    approvalRule: mapApprovalRuleDataToApi(workflowTemplate.approvalRule),
    metadata: {}, // Metadata are currently not supported
    actions: workflowTemplate.actions.map(mapWorkflowActionToApi),
    defaultExpiresInHours: workflowTemplate.defaultExpiresInHours,
    spaceId: workflowTemplate.spaceId,
    createdAt: workflowTemplate.createdAt.toISOString(),
    updatedAt: workflowTemplate.updatedAt.toISOString(),
    status: workflowTemplate.status,
    allowVotingOnDeprecatedTemplate: workflowTemplate.allowVotingOnDeprecatedTemplate
  }
}

export function mapWorkflowTemplateListToApi(data: ListWorkflowTemplatesResponse): ListWorkflowTemplates200Response {
  return {
    data: data.templates.map(mapWorkflowTemplateSummaryToApi),
    pagination: {
      total: data.pagination.total,
      page: data.pagination.page,
      limit: data.pagination.limit
    }
  }
}

function mapWorkflowTemplateSummaryToApi(workflowTemplateSummary: WorkflowTemplateSummary): WorkflowTemplateSummaryApi {
  return {
    id: workflowTemplateSummary.id,
    name: workflowTemplateSummary.name,
    version: workflowTemplateSummary.version.toString(),
    description: workflowTemplateSummary.description,
    createdAt: workflowTemplateSummary.createdAt.toISOString(),
    updatedAt: workflowTemplateSummary.updatedAt.toISOString()
  }
}

function mapWorkflowActionToApi(action: WorkflowAction): WorkflowActionApi {
  switch (action.type) {
    case WorkflowActionType.EMAIL:
      return {
        type: action.type,
        recipients: action.recipients.slice()
      }
    case WorkflowActionType.WEBHOOK:
      return {
        type: action.type,
        url: action.url,
        method: action.method,
        headers: action.headers ? {...action.headers} : undefined
      }
  }
}

type CreateWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "createWorkflowTemplate">

export function generateErrorResponseForCreateWorkflowTemplate(
  error: CreateWorkflowTemplateLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_action_url_invalid":
    case "workflow_action_method_invalid":
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_status_invalid":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template with this name already exists`)
      )
    case "workflow_template_update_before_create":
    case "workflow_template_active_is_not_latest":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Found internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type GetWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "getWorkflowTemplateById">

export function generateErrorResponseForGetWorkflowTemplate(
  error: GetWorkflowTemplateLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_action_url_invalid":
    case "workflow_action_method_invalid":
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_status_invalid":
    case "workflow_template_update_before_create":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_active_is_not_latest":
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

type UpdateWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "updateWorkflowTemplate">

export function generateErrorResponseForUpdateWorkflowTemplate(
  error: UpdateWorkflowTemplateLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template has been updated concurrently`)
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_action_url_invalid":
    case "workflow_action_method_invalid":
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_status_invalid":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_update_before_create":
    case "workflow_template_active_is_not_latest":
    case "workflow_template_most_recent_non_active_invalid_status":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Found internal data inconsistency`)
      )
    case "workflow_template_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template with this name already exists`)
      )
    case "workflow_template_not_active":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Workflow template is not active`))
    case "workflow_template_not_pending_deprecation":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Workflow template is not pending deprecation`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type DeleteWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "deprecateWorkflowTemplate">

export function generateErrorResponseForDeprecateWorkflowTemplate(
  error: DeleteWorkflowTemplateLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
    case "workflow_template_not_active":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Workflow template is not active`))
    case "workflow_template_not_pending_deprecation":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Workflow template is not pending deprecation`)
      )
    case "workflow_template_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template with this name already exists`)
      )
    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template has been updated concurrently`)
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_action_url_invalid":
    case "workflow_action_method_invalid":
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_status_invalid":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_update_before_create":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_active_is_not_latest":
    case "workflow_template_most_recent_non_active_invalid_status":
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unknown error occurred`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type ListWorkflowTemplatesLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "listWorkflowTemplates">

export function generateErrorResponseForListWorkflowTemplates(
  error: ListWorkflowTemplatesLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_action_url_invalid":
    case "workflow_action_method_invalid":
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_status_invalid":
    case "workflow_template_space_id_invalid_uuid":
    case "workflow_template_update_before_create":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_template_active_is_not_latest":
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unknown error occurred`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}
