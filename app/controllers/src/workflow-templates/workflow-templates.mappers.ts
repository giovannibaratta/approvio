import {
  WorkflowTemplateCreate as WorkflowTemplateCreateApi,
  WorkflowTemplateUpdate as WorkflowTemplateUpdateApi,
  WorkflowAction as WorkflowActionApi,
  WorkflowTemplate as WorkflowTemplateApi,
  WorkflowTemplateSummary as WorkflowTemplateSummaryApi,
  ApprovalRule as ApprovalRuleApi,
  ListWorkflowTemplates200Response,
  validateListWorkflowTemplatesParams,
  ListWorkflowTemplatesParams,
  SortBy,
  SortDirection
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
  AuthenticatedEntity,
  Versioned,
  WorkflowTemplateStatus
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
  WorkflowTemplateService,
  ListWorkflowTemplatesRequest,
  Sort
} from "@services"
import {ExtractLeftFromFn, ExtractLeftFromMethod, getStringAsEnum} from "@utils"
import {Either, isLeft, right} from "fp-ts/Either"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

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
    requestor: data.requestor,
    occVersion: BigInt(data.workflowTemplateData.concurrencyControl.version)
  })
}

function mapApprovalRuleToDomain(apiRule: ApprovalRuleApi): Either<ApprovalRuleValidationError, ApprovalRule> {
  return ApprovalRuleFactory.validate(apiRule)
}

export function mapWorkflowTemplateToApi(workflowTemplate: Versioned<WorkflowTemplate>): WorkflowTemplateApi {
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
    allowVotingOnDeprecatedTemplate: workflowTemplate.allowVotingOnDeprecatedTemplate,
    concurrencyControl: {version: workflowTemplate.occ.toString()}
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

export function mapListWorkflowTemplatesParamsToServiceRequest(
  params: ListWorkflowTemplatesParams,
  requestor: AuthenticatedEntity
): Either<
  "invalid_status" | "invalid_search_mode" | "invalid_sort_direction" | "invalid_sort_by",
  ListWorkflowTemplatesRequest
> {
  const statusEither = pipe(
    (params.status as string[] | undefined) ?? [],
    E.traverseArray((s: string) =>
      E.fromNullable("invalid_status" as const)(getStringAsEnum(s.toUpperCase(), WorkflowTemplateStatus))
    ),
    E.chain(statuses => {
      if (params.status === undefined) return E.right(undefined)
      const first = statuses[0]
      if (first === undefined) return E.left("invalid_status" as const)
      return E.right([first, ...statuses.slice(1)] as [WorkflowTemplateStatus, ...WorkflowTemplateStatus[]])
    })
  )

  const searchModeEither = pipe(
    params.searchMode,
    E.fromPredicate(
      mode => mode === undefined || mode === "CONTAINS" || mode === "EXACT",
      () => "invalid_search_mode" as const
    )
  )

  const sortDirectionEither = pipe(
    (params.sortDirection as string[] | undefined) ?? [],
    E.traverseArray((v: string) =>
      E.fromNullable("invalid_sort_direction" as const)(getStringAsEnum(v.toUpperCase(), SortDirection))
    )
  )

  const sortByEither = pipe(
    (params.sortBy as string[] | undefined) ?? [],
    E.traverseArray((v: string) => E.fromNullable("invalid_sort_by" as const)(getStringAsEnum(v.toUpperCase(), SortBy)))
  )

  return pipe(
    statusEither,
    E.chainW(status =>
      pipe(
        searchModeEither,
        E.chainW(searchMode =>
          pipe(
            sortDirectionEither,
            E.chainW(sortDirection =>
              pipe(
                sortByEither,
                E.map(sortBy => {
                  const sort: Sort[] = sortBy.map((field, i) => ({
                    field,
                    direction: (sortDirection as SortDirection[])[i] ?? SortDirection.ASC
                  }))

                  return {
                    pagination: {
                      page: params.page ?? 1,
                      limit: params.limit ?? 20
                    },
                    search: params.search,
                    searchMode: searchMode as "CONTAINS" | "EXACT" | undefined,
                    sort: sort.length > 0 ? sort : undefined,
                    filters: {
                      spaceIdentifier: params.spaceIdentifier,
                      status
                    },
                    requestor
                  }
                })
              )
            )
          )
        )
      )
    )
  )
}

function mapWorkflowTemplateSummaryToApi(workflowTemplateSummary: WorkflowTemplateSummary): WorkflowTemplateSummaryApi {
  return {
    id: workflowTemplateSummary.id,
    name: workflowTemplateSummary.name,
    version: workflowTemplateSummary.version.toString(),
    status: workflowTemplateSummary.status,
    description: workflowTemplateSummary.description,
    createdAt: workflowTemplateSummary.createdAt.toISOString(),
    updatedAt: workflowTemplateSummary.updatedAt.toISOString()
  }
}

export function mapWorkflowActionToApi(action: WorkflowAction): WorkflowActionApi {
  switch (action.type) {
    case WorkflowActionType.EMAIL:
      return {
        type: action.type,
        recipients: action.recipients.slice()
      }
    case WorkflowActionType.WEBHOOK: {
      const redactScope = action.redact
      const redactHeadersMode = redactScope === "HEADERS" || redactScope === "ALL" ? "all" : "smart"
      const redactUrlMode = redactScope === "URL" || redactScope === "ALL" ? "all" : "smart"

      let redactedUrl = action.url
      const isSensitiveKey = (key: string): boolean => {
        const lowerKey = key.toLowerCase()
        return (
          lowerKey.includes("auth") ||
          lowerKey.includes("token") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("key") ||
          lowerKey.includes("password") ||
          lowerKey.includes("credential")
        )
      }

      try {
        const urlObj = new URL(action.url)
        let modified = false

        if (urlObj.username) {
          urlObj.username = "***"
          modified = true
        }

        if (urlObj.password) {
          urlObj.password = "***"
          modified = true
        }

        const params = new URLSearchParams(urlObj.search)
        for (const [key] of params.entries()) {
          if (redactUrlMode === "all" || isSensitiveKey(key)) {
            params.set(key, "***")
            modified = true
          }
        }
        if (modified) {
          urlObj.search = params.toString()
          redactedUrl = urlObj.toString()
        }
      } catch {
        // Fallback if URL parsing fails
      }

      let redactedHeaders: Record<string, string> | undefined = undefined

      if (action.headers) {
        redactedHeaders = {}
        for (const [key, value] of Object.entries(action.headers)) {
          redactedHeaders[key] = redactHeadersMode === "all" || isSensitiveKey(key) ? "***" : value
        }
      }

      return {
        type: action.type,
        url: redactedUrl,
        method: action.method,
        headers: redactedHeaders,
        redact: action.redact
      }
    }
    case WorkflowActionType.SLACK: {
      const getRedactedSlackUrl = (): string => {
        try {
          const urlObj = new URL(action.webhookUrl)
          const parts = urlObj.pathname.split("/")
          if (parts[1] === "services") return `${urlObj.origin}/services/***`

          return `${urlObj.origin}/***`
        } catch {
          return "***"
        }
      }
      return {
        type: action.type,
        webhookUrl: getRedactedSlackUrl()
      }
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
    case "quota_exceeded":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: quota exceeded for creating workflow template`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(
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
    case "workflow_action_webhook_url_invalid":
    case "workflow_action_redact_invalid":
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
    case "quota_check_error":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}

type GetWorkflowTemplateLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "getWorkflowTemplateByIdentifier">

export function generateErrorResponseForGetWorkflowTemplate(
  error: GetWorkflowTemplateLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_template_not_found":
    case "active_workflow_template_not_found":
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
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
    case "workflow_action_webhook_url_invalid":
    case "workflow_action_redact_invalid":
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
      return new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "active_workflow_template_not_found":
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
    case "workflow_action_webhook_url_invalid":
    case "workflow_action_redact_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow template data`))
    case "workflow_template_update_before_create":
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
    case "quota_check_error":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    case "quota_exceeded":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: quota exceeded`))
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
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
      return new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
    case "active_workflow_template_not_found":
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
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
    case "workflow_action_webhook_url_invalid":
    case "workflow_action_redact_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unknown error occurred`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    case "workflow_template_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow template not found`))
  }
}

type ListWorkflowTemplatesLeft = ExtractLeftFromMethod<typeof WorkflowTemplateService, "listWorkflowTemplates">
type ListWorkflowRequestValidationLeft = ExtractLeftFromFn<typeof validateListWorkflowTemplatesParams>

export function generateErrorResponseForListWorkflowTemplates(
  error: ListWorkflowTemplatesLeft | ListWorkflowRequestValidationLeft,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_page":
    case "invalid_limit":
    case "invalid_search":
    case "invalid_search_mode":
    case "invalid_search_length":
    case "invalid_space_identifier":
    case "invalid_status":
    case "malformed_object":
    case "invalid_sort_by":
    case "invalid_sort_direction":
    case "sort_direction_without_sort_by":
    case "sort_direction_length_mismatch":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid list parameters`))
    case "requestor_not_authorized":
      return new ForbiddenException(
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
    case "workflow_action_missing_http_method":
    case "workflow_action_headers_invalid":
    case "workflow_action_webhook_url_invalid":
    case "workflow_action_redact_invalid":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unknown error occurred`)
      )
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}
