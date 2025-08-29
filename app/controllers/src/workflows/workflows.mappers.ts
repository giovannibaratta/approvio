import {
  CreateWorkflowRequest,
  WorkflowService,
  CanVoteResponse,
  CastVoteRequest,
  CastVoteServiceError,
  CanVoteError,
  ListWorkflowsResponse,
  AuthenticatedEntity
} from "@services"
import {ExtractLeftFromMethod} from "@utils"
import {Either, right, left} from "fp-ts/Either"
import {
  WorkflowCreate as WorkflowCreateApi,
  ListWorkflows200Response,
  WorkflowVoteRequest as WorkflowVoteRequestApi,
  CanVoteResponse as CanVoteResponseApi,
  Workflow as WorkflowApi
} from "@approvio/api"
import {
  HttpException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
  UnprocessableEntityException,
  Logger
} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"
import {
  ApprovalRuleValidationError,
  DecoratedWorkflow,
  isDecoratedWorkflow,
  VoteValidationError,
  WorkflowDecoratorSelector
} from "@domain"
import {mapWorkflowTemplateToApi} from "@controllers/workflow-templates"

type CreateWorkflowApiError =
  | "name_missing"
  | "name_not_string"
  | "description_not_string"
  | "metadata_malformed"
  | "workflow_template_id_not_string"
  | "workflow_template_id_missing"
  | "malformed_request"

/** Validate the workflow create request is valid based on the API model.
 * Semantic validation is not performed at this stage.
 */
export function validateWorkflowCreateRequest(request: unknown): Either<CreateWorkflowApiError, WorkflowCreateApi> {
  let description: string | undefined = undefined
  let metadata: Record<string, string> | undefined = undefined

  if (typeof request !== "object" || request === null) return left("malformed_request")
  if (!("name" in request)) return left("name_missing")
  if (typeof request.name !== "string") return left("name_not_string")
  if ("description" in request && typeof request.description !== "string") return left("description_not_string")
  if ("description" in request && typeof request.description === "string") description = request.description
  if (!("workflowTemplateId" in request)) return left("workflow_template_id_missing")
  if (typeof request.workflowTemplateId !== "string") return left("workflow_template_id_not_string")
  if ("metadata" in request && !isValidMetadata(request.metadata)) return left("metadata_malformed")
  if ("metadata" in request && isValidMetadata(request.metadata)) metadata = request.metadata

  return right({
    name: request.name,
    description,
    workflowTemplateId: request.workflowTemplateId,
    metadata
  })
}

function isValidMetadata(metadata: unknown): metadata is Record<string, string> {
  if (typeof metadata !== "object" || metadata === null) return false
  return Object.values(metadata).every(value => typeof value === "string")
}

export function createWorkflowApiToServiceModel(data: {
  workflowData: WorkflowCreateApi
  requestor: AuthenticatedEntity
}): Either<ApprovalRuleValidationError, CreateWorkflowRequest> {
  const workflowData: CreateWorkflowRequest["workflowData"] = {
    name: data.workflowData.name,
    description: data.workflowData.description,
    workflowTemplateId: data.workflowData.workflowTemplateId
  }

  return right({
    workflowData,
    requestor: data.requestor
  })
}

type CreateWorkflowLeft = ExtractLeftFromMethod<typeof WorkflowService, "createWorkflow">

export function generateErrorResponseForCreateWorkflow(
  error: CreateWorkflowLeft | CreateWorkflowApiError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_name_empty":
    case "workflow_name_too_long":
    case "workflow_name_invalid_characters":
    case "workflow_description_too_long":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_template_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow data`))
    case "workflow_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow with this name already exists`)
      )
    case "workflow_update_before_create":
    case "workflow_expires_at_in_the_past":
    case "workflow_status_invalid":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    case "name_missing":
    case "name_not_string":
    case "description_not_string":
    case "metadata_malformed":
    case "workflow_template_id_not_string":
    case "workflow_template_id_missing":
    case "malformed_request":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: request is malformed or invalid`))
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
    case "workflow_template_status_invalid":
    case "workflow_template_update_before_create":
    case "workflow_template_version_invalid_format":
    case "workflow_template_version_invalid_number":
    case "workflow_template_version_too_long":
    case "workflow_template_active_is_not_latest":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

type GetWorkflowLeft = ExtractLeftFromMethod<typeof WorkflowService, "getWorkflowByIdentifier">

export function generateErrorResponseForGetWorkflow(error: GetWorkflowLeft, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "workflow_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Workflow not found`))
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow has been updated concurrently`)
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "vote_invalid_group_id":
    case "vote_invalid_user_id":
    case "vote_invalid_vote_type":
    case "vote_invalid_workflow_id":
    case "vote_reason_too_long":
    case "vote_voted_for_groups_required":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_description_too_long":
    case "workflow_expires_at_in_the_past":
    case "workflow_name_empty":
    case "workflow_name_invalid_characters":
    case "workflow_name_too_long":
    case "workflow_status_invalid":
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
    case "workflow_update_before_create":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_template_active_is_not_latest":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

type ListWorkflowsLeft = ExtractLeftFromMethod<typeof WorkflowService, "listWorkflows">

export function generateErrorResponseForListWorkflows(error: ListWorkflowsLeft, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
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
    case "workflow_description_too_long":
    case "workflow_expires_at_in_the_past":
    case "workflow_name_empty":
    case "workflow_name_invalid_characters":
    case "workflow_name_too_long":
    case "workflow_not_found":
    case "workflow_status_invalid":
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
    case "workflow_update_before_create":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_template_active_is_not_latest":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
  }
}

/** Map the domain model to the API model */
export function mapWorkflowToApi<T extends WorkflowDecoratorSelector>(
  workflowResult: DecoratedWorkflow<T>,
  includeRequestedByUser?: T
): WorkflowApi {
  const {id, name, description, status, createdAt, updatedAt, expiresAt, workflowTemplateId} = workflowResult
  const workflow: WorkflowApi = {
    id,
    name,
    status,
    workflowTemplateId,
    metadata: {},
    description,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  }

  const ref: WorkflowApi["ref"] = {}

  if (isDecoratedWorkflow(workflowResult, "workflowTemplate", includeRequestedByUser)) {
    ref.workflowTemplate = mapWorkflowTemplateToApi(workflowResult.workflowTemplate)
  }

  return {
    ...workflow,
    ref
  }
}

/** Map the domain model to the API model */
export function mapWorkflowListToApi(
  response: ListWorkflowsResponse<{workflowTemplate: boolean}>
): ListWorkflows200Response {
  return {
    data: response.workflows.map(item => mapWorkflowToApi(item, {workflowTemplate: true})),
    pagination: {
      total: response.pagination.total,
      page: response.pagination.page,
      limit: response.pagination.limit
    }
  }
}

/** Map the domain model to the API model */
export function mapCanVoteResponseToApi(response: CanVoteResponse): CanVoteResponseApi {
  const cantVoteReason = mapCantVoteReasonToApi(response)

  return {
    canVote: response.canVote === true,
    voteStatus: response.status,
    cantVoteReason
  }
}

function mapCantVoteReasonToApi(response: CanVoteResponse): string | undefined {
  if (response.canVote === true) return undefined
  switch (response.canVote.reason) {
    case "workflow_expired":
      return "WORKFLOW_EXPIRED"
    case "workflow_cancelled":
      return "WORKFLOW_CANCELED"
    case "workflow_already_approved":
      return "WORKFLOW_APPROVED"
    case "entity_not_in_required_group":
      return "ENTITY_NOT_IN_GROUP"
    case "workflow_template_not_active":
      return "WORKFLOW_TEMPLATE_NOT_ACTIVE"
    case "entity_not_eligible_to_vote":
      return "NO_PERMISSIONS"
  }
}

type VoteApiValidationError =
  | "malformed_request"
  | "vote_type_missing"
  | "vote_type_malformed"
  | "vote_type_invalid"
  | "voted_for_groups_missing"
  | "voted_for_groups_invalid"
  | "reason_invalid"

/** Validate the vote request structure and enum values according to OpenAPI spec */
export function validateApiRequest(request: unknown): Either<VoteApiValidationError, WorkflowVoteRequestApi> {
  if (typeof request !== "object" || request === null) {
    return left("malformed_request")
  }

  const requestObj = request as Record<string, unknown>

  if (!("voteType" in requestObj)) return left("vote_type_missing")

  if (typeof requestObj.voteType !== "object" || requestObj.voteType === null) {
    return left("vote_type_malformed")
  }

  const voteTypeObj = requestObj.voteType as Record<string, unknown>

  if (!("type" in voteTypeObj) || typeof voteTypeObj.type !== "string") {
    return left("vote_type_malformed")
  }

  // Validate vote type enum values
  const validVoteTypes = ["APPROVE", "VETO", "WITHDRAW"] as const
  if (!(validVoteTypes as readonly string[]).includes(voteTypeObj.type)) {
    return left("vote_type_invalid")
  }

  const voteTypeString = voteTypeObj.type as "APPROVE" | "VETO" | "WITHDRAW"

  // For APPROVE votes, votedForGroups is required
  if (voteTypeString === "APPROVE") {
    if (!("votedForGroups" in voteTypeObj)) {
      return left("voted_for_groups_missing")
    }

    if (!Array.isArray(voteTypeObj.votedForGroups) || !voteTypeObj.votedForGroups.every(id => typeof id === "string")) {
      return left("voted_for_groups_invalid")
    }
  }

  // Validate optional reason field
  if ("reason" in requestObj && requestObj.reason !== undefined && typeof requestObj.reason !== "string") {
    return left("reason_invalid")
  }

  // Construct the validated API request
  const voteType: WorkflowVoteRequestApi["voteType"] =
    voteTypeString === "APPROVE"
      ? {
          type: "APPROVE",
          votedForGroups: voteTypeObj.votedForGroups as string[]
        }
      : {type: voteTypeString}

  return right({
    voteType,
    reason: "reason" in requestObj ? (requestObj.reason as string) : undefined
  })
}

/** Map the API model to the domain model */
export function createCastVoteApiToServiceModel(data: {
  workflowId: string
  request: WorkflowVoteRequestApi
  requestor: AuthenticatedEntity
}): Either<VoteValidationError, CastVoteRequest> {
  switch (data.request.voteType.type) {
    case "APPROVE":
      return right({
        workflowId: data.workflowId,
        type: "APPROVE",
        votedForGroups: data.request.voteType.votedForGroups,
        reason: data.request.reason,
        requestor: data.requestor
      })
    case "VETO":
      return right({
        workflowId: data.workflowId,
        type: "VETO",
        reason: data.request.reason,
        requestor: data.requestor
      })
    case "WITHDRAW":
      return right({
        workflowId: data.workflowId,
        type: "WITHDRAW",
        reason: data.request.reason,
        requestor: data.requestor
      })
  }
}

export function generateErrorResponseForCanVote(error: CanVoteError, context: string): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "workflow_not_found":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Invalid parameters for vote eligibility check`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow has been updated concurrently`)
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "membership_inconsistent_dates":
    case "membership_invalid_group_uuid":
    case "membership_invalid_entity_uuid":
    case "vote_invalid_group_id":
    case "vote_invalid_user_id":
    case "vote_invalid_vote_type":
    case "vote_invalid_workflow_id":
    case "vote_reason_too_long":
    case "vote_voted_for_groups_required":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_description_too_long":
    case "workflow_expires_at_in_the_past":
    case "workflow_name_empty":
    case "workflow_name_invalid_characters":
    case "workflow_name_too_long":
    case "workflow_status_invalid":
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
    case "workflow_update_before_create":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_template_active_is_not_latest":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_uuid":
    case "role_invalid_structure":
    case "user_duplicate_roles":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: Internal data inconsistency`)
      )
    case "requestor_not_authorized":
      throw new ForbiddenException(
        generateErrorPayload(
          errorCode,
          `${context}: entity does not have sufficient permissions to perform this operation`
        )
      )
  }
}

export function generateErrorResponseForCastVote(
  error: CastVoteServiceError | VoteApiValidationError,
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
    case "workflow_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Workflow not found`))
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "entity_not_eligible_to_vote":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: User is not eligible to vote`))
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("VOTE_CAST_FAILED", `${context}: An unexpected error occurred while casting vote`)
      )
    case "malformed_request":
    case "vote_type_missing":
    case "vote_type_malformed":
    case "vote_type_invalid":
    case "voted_for_groups_missing":
    case "voted_for_groups_invalid":
    case "reason_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid request format`))
    case "vote_invalid_group_id":
    case "vote_invalid_user_id":
    case "vote_invalid_vote_type":
    case "vote_invalid_workflow_id":
    case "vote_reason_too_long":
    case "vote_voted_for_groups_required":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid vote parameters`))
    case "concurrency_error":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow has been updated concurrently`)
      )
    case "approval_rule_and_rule_must_have_rules":
    case "approval_rule_group_rule_invalid_group_id":
    case "approval_rule_group_rule_invalid_min_count":
    case "approval_rule_invalid_rule_type":
    case "approval_rule_malformed_content":
    case "approval_rule_max_rule_nesting_exceeded":
    case "approval_rule_or_rule_must_have_rules":
    case "membership_inconsistent_dates":
    case "membership_invalid_group_uuid":
    case "membership_invalid_entity_uuid":
    case "workflow_action_recipients_empty":
    case "workflow_action_recipients_invalid_email":
    case "workflow_action_type_invalid":
    case "workflow_description_too_long":
    case "workflow_expires_at_in_the_past":
    case "workflow_name_empty":
    case "workflow_name_invalid_characters":
    case "workflow_name_too_long":
    case "workflow_status_invalid":
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
    case "workflow_update_before_create":
    case "workflow_workflow_template_id_invalid_uuid":
    case "workflow_template_active_is_not_latest":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_invalid_uuid":
    case "user_duplicate_roles":
    case "role_invalid_structure":
      Logger.error(`${context}: Found internal data inconsistency: ${error}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "workflow_already_approved":
    case "workflow_cancelled":
    case "workflow_expired":
    case "entity_not_in_required_group":
    case "workflow_template_not_active":
      return new UnprocessableEntityException(generateErrorPayload(errorCode, `${context}: Cannot cast vote`))
  }
}
