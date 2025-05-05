import {
  AndRule as ApiAndRule,
  ApprovalRule as ApiApprovalRule,
  GroupRequirementRule as ApiGroupRequirementRule,
  OrRule as ApiOrRule,
  WorkflowCreate
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
  User
} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException
} from "@nestjs/common"
import {AuthorizationError, CreateWorkflowError, CreateWorkflowRequest} from "@services"
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

function mapApprovalRuleToDomain(apiRule: ApiApprovalRule): Either<ApprovalRuleValidationError, ApprovalRule> {
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

function mapOrRuleToDomain(apiRule: ApiOrRule): Either<ApprovalRuleValidationError, OrRule> {
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

function mapAndRuleToDomain(apiRule: ApiAndRule): Either<ApprovalRuleValidationError, AndRule> {
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

export function generateErrorResponseForCreateWorkflow(
  error: CreateWorkflowError | AuthorizationError,
  context: string
): HttpException {
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
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "update_before_create":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: An unknown error occurred`))
  }
}
