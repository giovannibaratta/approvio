import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {ApprovalRule, ApprovalRuleFactory, ApprovalRuleValidationError} from "./approval-rules"
import {WorkflowAction, validateWorkflowActions} from "./workflow-actions"
import {HumanGroupMembershipRole, MembershipWithGroupRef} from "@domain"

export const WORKFLOW_TEMPLATE_NAME_MAX_LENGTH = 512
export const WORKFLOW_TEMPLATE_DESCRIPTION_MAX_LENGTH = 2048
export const MAX_EXPIRES_IN_HOURS = 8760 // 1 year

export type WorkflowTemplate = Readonly<WorkflowTemplateData & WorkflowTemplateLogic>

interface WorkflowTemplateData {
  id: string
  name: string
  description?: string
  approvalRule: ApprovalRule
  actions: ReadonlyArray<WorkflowAction>
  defaultExpiresInHours?: number
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowTemplateSummary {
  id: string
  name: string
  description?: string
  createdAt: Date
  updatedAt: Date
}

interface WorkflowTemplateLogic {
  canVote(memberships: ReadonlyArray<MembershipWithGroupRef>): boolean
}

export type WorkflowTemplateValidationError =
  | "name_empty"
  | "name_too_long"
  | "name_invalid_characters"
  | "description_too_long"
  | "update_before_create"
  | "rule_invalid"
  | "action_invalid"
  | "action_type_invalid"
  | "action_recipients_empty"
  | "action_recipients_invalid_email"
  | "expires_in_hours_invalid"
  | ApprovalRuleValidationError

export class WorkflowTemplateFactory {
  /**
   * Validates partial attributes for workflow template updates.
   * Only validates attributes that are defined in the partial object.
   * @param partialData Partial workflow template data to validate.
   * @returns Either a validation error or void if valid.
   */
  static validateAttributes(
    partialData: Partial<Parameters<typeof WorkflowTemplateFactory.createWorkflowTemplate>[0]>
  ): Either<WorkflowTemplateValidationError, void> {
    if (partialData.name !== undefined) {
      const nameValidation = validateWorkflowTemplateName(partialData.name)
      if (isLeft(nameValidation)) return nameValidation
    }

    if (partialData.description !== undefined) {
      const descriptionValidation = validateWorkflowTemplateDescription(partialData.description)
      if (isLeft(descriptionValidation)) return descriptionValidation
    }

    if (partialData.approvalRule !== undefined) {
      const ruleValidation = ApprovalRuleFactory.validate(partialData.approvalRule)
      if (isLeft(ruleValidation)) return ruleValidation
    }

    if (partialData.actions !== undefined) {
      const actionsValidation = validateWorkflowActions(partialData.actions)
      if (isLeft(actionsValidation)) return actionsValidation
    }

    if (partialData.defaultExpiresInHours !== undefined) {
      const expiresValidation = validateExpiresInHours(partialData.defaultExpiresInHours)
      if (isLeft(expiresValidation)) return expiresValidation
    }

    return right(undefined)
  }

  /**
   * Validates an existing WorkflowTemplate object.
   * @param data The WorkflowTemplate object to validate.
   * @returns Either a validation error or the valid WorkflowTemplate object.
   */
  static validate(
    data: Parameters<typeof WorkflowTemplateFactory.createWorkflowTemplate>[0]
  ): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
    return WorkflowTemplateFactory.createWorkflowTemplate(data)
  }

  /**
   * Creates a new WorkflowTemplate object with validation.
   * Generates a UUID and sets the creation timestamp.
   * @param data Request data for creating a workflow template.
   * @returns Either a validation error or the newly created WorkflowTemplate object.
   */
  static newWorkflowTemplate(
    data: Omit<Parameters<typeof WorkflowTemplateFactory.validate>[0], "id" | "createdAt" | "updatedAt">
  ): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
    const uuid = randomUUID()
    const now = new Date()
    const template = {
      ...data,
      id: uuid,
      createdAt: now,
      updatedAt: now
    }

    return WorkflowTemplateFactory.validate(template)
  }

  /**
   * Performs the core validation logic for a WorkflowTemplate object.
   * @param data The WorkflowTemplate object data.
   * @returns Either a validation error or the validated WorkflowTemplate object.
   */
  private static createWorkflowTemplate(
    data: Omit<WorkflowTemplateData, "approvalRule" | "actions"> & {
      approvalRule: unknown
      actions: unknown
    }
  ): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
    const nameValidation = validateWorkflowTemplateName(data.name)
    const descriptionValidation = data.description
      ? validateWorkflowTemplateDescription(data.description)
      : right(undefined)
    const ruleValidation = ApprovalRuleFactory.validate(data.approvalRule)
    const actionsValidation = validateWorkflowActions(data.actions)
    const expiresValidation =
      data.defaultExpiresInHours !== undefined ? validateExpiresInHours(data.defaultExpiresInHours) : right(undefined)

    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (isLeft(ruleValidation)) return ruleValidation
    if (isLeft(actionsValidation)) return actionsValidation
    if (isLeft(expiresValidation)) return expiresValidation
    if (data.createdAt > data.updatedAt) return left("update_before_create")

    const workflowTemplateData = {
      ...data,
      name: nameValidation.right,
      description: descriptionValidation.right,
      approvalRule: ruleValidation.right,
      actions: actionsValidation.right,
      defaultExpiresInHours: expiresValidation.right
    }

    return right({
      ...workflowTemplateData,
      canVote: (memberships: ReadonlyArray<MembershipWithGroupRef>) => canVote(workflowTemplateData, memberships)
    })
  }
}

function validateWorkflowTemplateName(name: string): Either<WorkflowTemplateValidationError, string> {
  if (!name || name.trim().length === 0) return E.left("name_empty")
  if (name.length > WORKFLOW_TEMPLATE_NAME_MAX_LENGTH) return E.left("name_too_long")
  // String must start and end with a letter or number
  // String can only contain letters, numbers, hyphens and spaces
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-\s]+[a-zA-Z0-9]$/.test(name)) return E.left("name_invalid_characters")

  return E.right(name)
}

function validateWorkflowTemplateDescription(description: string): Either<WorkflowTemplateValidationError, string> {
  if (description.length > WORKFLOW_TEMPLATE_DESCRIPTION_MAX_LENGTH) return E.left("description_too_long")

  return E.right(description)
}

function validateExpiresInHours(hours: unknown): Either<WorkflowTemplateValidationError, number> {
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_EXPIRES_IN_HOURS) {
    return left("expires_in_hours_invalid")
  }

  return right(hours)
}

const ROLES_ALLOWED_TO_VOTE: HumanGroupMembershipRole[] = [
  HumanGroupMembershipRole.APPROVER,
  HumanGroupMembershipRole.ADMIN,
  HumanGroupMembershipRole.OWNER
]

function canVote(workflowTemplate: WorkflowTemplateData, memberships: ReadonlyArray<MembershipWithGroupRef>): boolean {
  const votingGroups = workflowTemplate.approvalRule.getVotingGroupIds()

  // Is it possible to vote if at least one of the membership group is listed in approval rules
  // and the user has an allowed role in that group
  return memberships.some(
    membership => votingGroups.includes(membership.groupId) && ROLES_ALLOWED_TO_VOTE.includes(membership.role)
  )
}
