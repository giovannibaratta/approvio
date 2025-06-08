import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {ApprovalRule, ApprovalRuleFactory, ApprovalRuleType, ApprovalRuleValidationError} from "./approval-rules"
import {getStringAsEnum} from "@utils"
import {
  MembershipWithGroupRef,
  HumanGroupMembershipRole,
  Vote,
  consolidateVotes,
  doesVotesCoverApprovalRules
} from "@domain"

export const WORKFLOW_NAME_MAX_LENGTH = 512
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 2048

export enum WorkflowStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  CANCELED = "CANCELED",
  EVALUATION_IN_PROGRESS = "EVALUATION_IN_PROGRESS"
}

export type Workflow = Readonly<WorkflowData & WorkflowLogic>

interface WorkflowData {
  id: string
  name: string
  description?: string
  rule: ApprovalRule
  status: WorkflowStatus
  recalculationRequired: boolean
  createdAt: Date
  updatedAt: Date
}

interface WorkflowLogic {
  canVote(memberships: ReadonlyArray<MembershipWithGroupRef>): boolean
  evaluateStatus(votes: ReadonlyArray<Vote>): Either<WorkflowValidationError, Workflow>
}

export type WorkflowValidationError =
  | "name_empty"
  | "name_too_long"
  | "name_invalid_characters"
  | "description_too_long"
  | "update_before_create"
  | "rule_invalid"
  | "status_invalid"
  | ApprovalRuleValidationError

export class WorkflowFactory {
  /**
   * Validates an existing Workflow object.
   * @param data The Workflow object to validate.
   * @returns Either a validation error or the valid Workflow object.
   */
  static validate(
    data: Parameters<typeof WorkflowFactory.createWorkflow>[0]
  ): Either<WorkflowValidationError, Workflow> {
    return WorkflowFactory.createWorkflow(data)
  }

  /**
   * Creates a new Workflow object with validation.
   * Generates a UUID and sets the creation timestamp.
   * @param data Request data for creating a workflow.
   * @returns Either a validation error or the newly created Workflow object.
   */
  static newWorkflow(
    data: Omit<
      Parameters<typeof WorkflowFactory.validate>[0],
      "id" | "createdAt" | "updatedAt" | "status" | "recalculationRequired"
    >
  ): Either<WorkflowValidationError, Workflow> {
    const uuid = randomUUID()
    const now = new Date()
    const workflow = {
      ...data,
      id: uuid,
      status: WorkflowStatus.PENDING,
      recalculationRequired: false,
      createdAt: now,
      updatedAt: now
    }

    return WorkflowFactory.validate(workflow)
  }

  /**
   * Performs the core validation logic for an Workflow object.
   * @param data The Workflow object data.
   * @returns Either a validation error or the validated Workflow object.
   */
  private static createWorkflow(
    data: Omit<WorkflowData, "status" | "rule"> & {
      status: string
      rule: unknown
    }
  ): Either<WorkflowValidationError, Workflow> {
    const nameValidation = validateWorkflowName(data.name)
    const descriptionValidation = data.description ? validateWorkflowDescription(data.description) : right(undefined)
    const ruleValidation = ApprovalRuleFactory.validate(data.rule)
    const statusValidation = validateWorkflowStatus(data.status)

    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (isLeft(ruleValidation)) return ruleValidation
    if (data.createdAt > data.updatedAt) return left("update_before_create")
    if (isLeft(statusValidation)) return statusValidation

    const workflowData = {
      ...data,
      name: nameValidation.right,
      description: descriptionValidation.right,
      rule: ruleValidation.right,
      status: data.recalculationRequired ? WorkflowStatus.EVALUATION_IN_PROGRESS : statusValidation.right
    }

    return right({
      ...workflowData,
      canVote: (memberships: ReadonlyArray<MembershipWithGroupRef>) => canVote(workflowData, memberships),
      evaluateStatus: (votes: ReadonlyArray<Vote>) => evaluateStatus(workflowData, votes)
    })
  }
}

const ROLES_ALLOWED_TO_VOTE: HumanGroupMembershipRole[] = [
  HumanGroupMembershipRole.APPROVER,
  HumanGroupMembershipRole.ADMIN,
  HumanGroupMembershipRole.OWNER
]

function canVote(workflow: WorkflowData, memberships: ReadonlyArray<MembershipWithGroupRef>): boolean {
  if (workflow.status === WorkflowStatus.CANCELED || workflow.status === WorkflowStatus.APPROVED) return false

  const votingGroups = getVotingGroups(workflow.rule)

  // Is it possible to vote if at least one of the membership group is listed in approval rules
  // and the user has an allowed role in that group
  return memberships.some(
    membership => votingGroups.includes(membership.groupId) && ROLES_ALLOWED_TO_VOTE.includes(membership.role)
  )
}

function evaluateStatus(workflow: WorkflowData, votes: ReadonlyArray<Vote>): Either<WorkflowValidationError, Workflow> {
  // After a workflow has been approved, it's not possible to change its status
  if (workflow.status === WorkflowStatus.APPROVED || workflow.status === WorkflowStatus.CANCELED)
    return WorkflowFactory.validate({...workflow, recalculationRequired: false})

  const votesConsolidated = consolidateVotes(votes)
  const votesAgainst = votesConsolidated.filter(vote => vote.type === "VETO")
  const votesFor = votesConsolidated.filter(vote => vote.type === "APPROVE")

  if (votesConsolidated.length === 0) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.PENDING)

  if (votesAgainst.length > 0) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.REJECTED)

  if (doesVotesCoverApprovalRules(workflow.rule, votesFor))
    return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.APPROVED)

  return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.PENDING)
}

function changeStatusAndMarkAsRecalculated(
  workflow: WorkflowData,
  status: WorkflowStatus
): Either<WorkflowValidationError, Workflow> {
  return WorkflowFactory.validate({...workflow, status, recalculationRequired: false})
}

function getVotingGroups(rule: ApprovalRule): ReadonlyArray<string> {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return [rule.groupId]
    case ApprovalRuleType.AND:
      return rule.rules.flatMap(getVotingGroups)
    case ApprovalRuleType.OR:
      return rule.rules.flatMap(getVotingGroups)
  }
}

function validateWorkflowName(name: string): Either<WorkflowValidationError, string> {
  if (!name || name.trim().length === 0) return E.left("name_empty")
  if (name.length > WORKFLOW_NAME_MAX_LENGTH) return E.left("name_too_long")
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return E.left("name_invalid_characters")

  return E.right(name)
}

function validateWorkflowDescription(description: string): Either<WorkflowValidationError, string> {
  if (description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH) return E.left("description_too_long")

  return E.right(description)
}

function validateWorkflowStatus(status: string): Either<WorkflowValidationError, WorkflowStatus> {
  const enumStatus = getStringAsEnum(status, WorkflowStatus)
  if (enumStatus === undefined) return left("status_invalid")
  return right(enumStatus)
}
