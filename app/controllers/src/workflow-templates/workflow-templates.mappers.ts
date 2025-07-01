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
  User,
  WorkflowAction,
  WorkflowActionType,
  WorkflowTemplateSummary
} from "@domain"
import {
  BadRequestException,
  ConflictException,
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
import {Either, isLeft, left, right, traverseArray} from "fp-ts/Either"

export function createWorkflowTemplateApiToServiceModel(data: {
  workflowTemplateData: WorkflowTemplateCreateApi
  requestor: User
}): Either<ApprovalRuleValidationError | WorkflowTemplateValidationError, CreateWorkflowTemplateRequest> {
  const eitherApprovalRule = mapApprovalRuleToDomain(data.workflowTemplateData.approvalRule)
  if (isLeft(eitherApprovalRule)) return eitherApprovalRule

  const actions = mapActionsToDomain(data.workflowTemplateData.actions)
  if (isLeft(actions)) return actions

  const workflowTemplateData: CreateWorkflowTemplateRequest["workflowTemplateData"] = {
    name: data.workflowTemplateData.name,
    description: data.workflowTemplateData.description,
    approvalRule: eitherApprovalRule.right,
    actions: actions.right,
    defaultExpiresInHours: data.workflowTemplateData.defaultExpiresInHours
  }

  return right({
    workflowTemplateData,
    requestor: data.requestor
  })
}

function mapActionsToDomain(
  actions?: WorkflowActionApi[]
): Either<WorkflowTemplateValidationError, ReadonlyArray<WorkflowAction>> {
  if (!actions) return right([])

  return traverseArray(mapWorkflowActionToDomain)(actions)
}

function mapWorkflowActionToDomain(action: WorkflowActionApi): Either<WorkflowTemplateValidationError, WorkflowAction> {
  switch (action.type) {
    case WorkflowActionType.EMAIL:
      return right({type: WorkflowActionType.EMAIL, recipients: action.recipients})
  }

  return left("workflow_action_type_invalid")
}

export function updateWorkflowTemplateApiToServiceModel(data: {
  templateId: string
  workflowTemplateData: WorkflowTemplateUpdateApi
  requestor: User
}): Either<ApprovalRuleValidationError | WorkflowTemplateValidationError, UpdateWorkflowTemplateRequest> {
  let approvalRule: ApprovalRule | undefined = undefined

  if (data.workflowTemplateData.approvalRule !== undefined) {
    const eitherApprovalRule = mapApprovalRuleToDomain(data.workflowTemplateData.approvalRule)
    if (isLeft(eitherApprovalRule)) return eitherApprovalRule
    approvalRule = eitherApprovalRule.right
  }

  const actions = mapActionsToDomain(data.workflowTemplateData.actions)
  if (isLeft(actions)) return actions

  const workflowTemplateData: UpdateWorkflowTemplateRequest["workflowTemplateData"] = {
    name: data.workflowTemplateData.name,
    description: data.workflowTemplateData.description,
    approvalRule,
    actions: actions.right,
    defaultExpiresInHours: data.workflowTemplateData.defaultExpiresInHours
  }

  return right({
    templateId: data.templateId,
    workflowTemplateData,
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
    description: workflowTemplate.description,
    approvalRule: mapApprovalRuleDataToApi(workflowTemplate.approvalRule),
    metadata: {}, // Metadata are currently not supported
    actions: workflowTemplate.actions.map(mapWorkflowActionToApi),
    defaultExpiresInHours: workflowTemplate.defaultExpiresInHours,
    createdAt: workflowTemplate.createdAt.toISOString(),
    updatedAt: workflowTemplate.updatedAt.toISOString()
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
  }
}

type CreateWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "createWorkflowTemplate">

export function generateErrorResponseForCreateWorkflowTemplate(error: CreateWorkflowTemplateLeft, context: string) {
  const errorCode = error.toUpperCase()

  switch (error) {
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
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow template with this name already exists`)
      )
    case "workflow_template_update_before_create":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Found internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type GetWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "getWorkflowTemplateById">

export function generateErrorResponseForGetWorkflowTemplate(error: GetWorkflowTemplateLeft, context: string) {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    default:
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: Invalid workflow template data`)
      )
  }
}

type UpdateWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "updateWorkflowTemplate">

export function generateErrorResponseForUpdateWorkflowTemplate(error: UpdateWorkflowTemplateLeft, context: string) {
  const errorCode = error.toUpperCase()

  switch (error) {
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
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_update_before_create":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Found internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type DeleteWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "deleteWorkflowTemplate">

export function generateErrorResponseForDeleteWorkflowTemplate(error: DeleteWorkflowTemplateLeft, context: string) {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type ListWorkflowTemplatesLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "listWorkflowTemplates">

export function generateErrorResponseForListWorkflowTemplates(error: ListWorkflowTemplatesLeft, context: string) {
  const errorCode = error.toUpperCase()

  switch (error) {
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
    case "workflow_template_description_too_long":
    case "workflow_template_expires_in_hours_invalid":
    case "workflow_template_name_empty":
    case "workflow_template_name_invalid_characters":
    case "workflow_template_name_too_long":
    case "workflow_template_update_before_create":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Found internal data inconsistency`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}
