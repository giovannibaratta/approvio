import {
  AndRule as AndRuleApi,
  ApprovalRule as ApprovalRuleApi,
  GroupRequirementRule as ApiGroupRequirementRule,
  OrRule as OrRuleApi,
  Workflow as WorkflowApi,
  WorkflowCreate,
  CanVoteResponse as CanVoteResponseApi,
  WorkflowVoteRequest as WorkflowVoteRequestApi
} from "@api"
import {generateErrorPayload} from "@controllers/error"
import {
  AndRule,
  ApprovalRule,
  ApprovalRuleFactory,
  ApprovalRuleType,
  ApprovalRuleValidationError,
  GroupRequirementRule,
  OrRule,
  User,
  Workflow
} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import {
  CreateWorkflowRequest,
  WorkflowService,
  CanVoteResponse,
  CastVoteRequest,
  CastVoteServiceError,
  CanVoteError
} from "@services"
import {ExtractLeftFromMethod} from "@utils"
import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"

export function createWorkflowApiToServiceModel(data: {
  workflowData: WorkflowCreate
  requestor: User
}): Either<ApprovalRuleValidationError, CreateWorkflowRequest> {
  const domainRule = mapApprovalRuleToDomain(data.workflowData.approvalRule)

  if (isLeft(domainRule)) return domainRule

  const workflowData: CreateWorkflowRequest["workflowData"] = {
    name: data.workflowData.name,
    description: data.workflowData.description,
    rule: domainRule.right
  }

  return right({
    workflowData,
    requestor: data.requestor
  })
}

function mapApprovalRuleToDomain(apiRule: ApprovalRuleApi): Either<ApprovalRuleValidationError, ApprovalRule> {
  let domainRule: Either<ApprovalRuleValidationError, ApprovalRule>

  switch (apiRule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      domainRule = mapGroupRequirementRuleToDomain(apiRule)
      break
    case ApprovalRuleType.OR:
      domainRule = mapOrRuleToDomain(apiRule)
      break
    case ApprovalRuleType.AND:
      domainRule = mapAndRuleToDomain(apiRule)
      break
    default:
      return left("invalid_rule_type")
  }

  if (isLeft(domainRule)) return domainRule

  return ApprovalRuleFactory.validate(domainRule.right)
}

function mapGroupRequirementRuleToDomain(
  apiRule: ApiGroupRequirementRule
): Either<ApprovalRuleValidationError, GroupRequirementRule> {
  return right({
    type: ApprovalRuleType.GROUP_REQUIREMENT,
    groupId: apiRule.groupId,
    minCount: apiRule.minCount
  })
}

function mapOrRuleToDomain(apiRule: OrRuleApi): Either<ApprovalRuleValidationError, OrRule> {
  return pipe(
    apiRule.rules,
    A.traverse(E.Applicative)(mapApprovalRuleToDomain),
    E.map(rules => {
      return {
        type: ApprovalRuleType.OR,
        rules
      }
    })
  )
}

function mapAndRuleToDomain(apiRule: AndRuleApi): Either<ApprovalRuleValidationError, AndRule> {
  return pipe(
    apiRule.rules,
    A.traverse(E.Applicative)(mapApprovalRuleToDomain),
    E.map(rules => {
      return {
        type: ApprovalRuleType.AND,
        rules
      }
    })
  )
}

type CreateWorkflowLeft = ExtractLeftFromMethod<typeof WorkflowService, "createWorkflow">

export function generateErrorResponseForCreateWorkflow(error: CreateWorkflowLeft, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "description_too_long":
    case "rule_invalid":
    case "status_invalid":
    case "invalid_rule_type":
    case "and_rule_must_have_rules":
    case "or_rule_must_have_rules":
    case "group_rule_invalid_min_count":
    case "group_rule_invalid_group_id":
    case "max_rule_nesting_exceeded":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid workflow data`))
    case "workflow_already_exists":
      return new ConflictException(
        generateErrorPayload(errorCode, `${context}: Workflow with this name already exists`)
      )
    case "update_before_create":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
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
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "description_too_long":
    case "update_before_create":
    case "rule_invalid":
    case "status_invalid":
    case "invalid_rule_type":
    case "and_rule_must_have_rules":
    case "or_rule_must_have_rules":
    case "group_rule_invalid_min_count":
    case "group_rule_invalid_group_id":
    case "max_rule_nesting_exceeded":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid workflow data`))
  }
}

export function mapWorkflowToApi(workflow: Workflow): WorkflowApi {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    approvalRule: mapApprovalRuleToApi(workflow.rule),
    metadata: {},
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString()
  }
}

function mapApprovalRuleToApi(rule: ApprovalRule): ApprovalRuleApi {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: rule.groupId,
        minCount: rule.minCount
      }
    case ApprovalRuleType.OR:
      return {
        type: ApprovalRuleType.OR,
        rules: rule.rules.map(mapApprovalRuleToApi)
      }
    case ApprovalRuleType.AND:
      return {
        type: ApprovalRuleType.AND,
        rules: rule.rules.map(mapApprovalRuleToApi)
      }
  }
}

export function mapCanVoteResponseToApi(response: CanVoteResponse): CanVoteResponseApi {
  return {
    canVote: response.canVote,
    voteStatus: response.status
  }
}

export function createCastVoteApiToServiceModel(data: {
  workflowId: string
  voteData: WorkflowVoteRequestApi
  requestor: User
}): CastVoteRequest {
  return {
    workflowId: data.workflowId,
    voteType: data.voteData.voteType,
    voteMode: data.voteData.voteMode.type,
    reason: data.voteData.reason,
    requestor: data.requestor
  }
}

export function generateErrorResponseForCanVote(error: CanVoteError, context: string): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "workflow_not_found":
    case "invalid_uuid":
    case "invalid_group_uuid":
    case "invalid_role":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Invalid parameters for vote eligibility check`)
      )
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "description_too_long":
    case "update_before_create":
    case "rule_invalid":
    case "status_invalid":
    case "invalid_rule_type":
    case "and_rule_must_have_rules":
    case "or_rule_must_have_rules":
    case "group_rule_invalid_min_count":
    case "group_rule_invalid_group_id":
    case "max_rule_nesting_exceeded":
    case "inconsistent_dates":
    case "invalid_workflow_id":
    case "invalid_user_id":
    case "invalid_vote_type":
    case "invalid_vote_mode":
    case "reason_too_long":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}

export function generateErrorResponseForCastVote(error: CastVoteServiceError, context: string): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
    case "workflow_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Workflow not found`))
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: User not found`))
    case "user_not_eligible_to_vote":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: User is not eligible to vote`))
    case "unknown_error":
      return new InternalServerErrorException(
        generateErrorPayload("VOTE_CAST_FAILED", `${context}: An unexpected error occurred while casting vote`)
      )
    case "invalid_workflow_id":
    case "invalid_user_id":
    case "invalid_vote_type":
    case "invalid_vote_mode":
    case "reason_too_long":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid vote parameters`))
    case "name_empty":
    case "name_too_long":
    case "name_invalid_characters":
    case "description_too_long":
    case "update_before_create":
    case "rule_invalid":
    case "status_invalid":
    case "invalid_rule_type":
    case "and_rule_must_have_rules":
    case "or_rule_must_have_rules":
    case "group_rule_invalid_min_count":
    case "group_rule_invalid_group_id":
    case "max_rule_nesting_exceeded":
    case "invalid_role":
    case "invalid_uuid":
    case "inconsistent_dates":
    case "invalid_group_uuid":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
}
