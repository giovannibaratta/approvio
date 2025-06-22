import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {getStringAsEnum, isUUIDv4} from "@utils"
import {MembershipWithGroupRef, Vote, consolidateVotes, doesVotesCoverApprovalRules} from "@domain"
import {WorkflowTemplate} from "./workflow-templates"

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
export type WorkflowWithTemplate = Readonly<WorkflowDataWithTemplate & WorkflowWithTemplateLogic>

interface WorkflowData {
  id: string
  name: string
  description?: string
  status: WorkflowStatus
  recalculationRequired: boolean
  workflowTemplateId: string
  createdAt: Date
  updatedAt: Date
}

interface WorkflowDataWithTemplate extends WorkflowData {
  workflowTemplateRef: WorkflowTemplate
}

interface WorkflowLogic {
  evaluateStatus(votes: ReadonlyArray<Vote>): Either<WorkflowValidationError, Workflow>
}

interface WorkflowWithTemplateLogic extends WorkflowLogic {
  canVote(memberships: ReadonlyArray<MembershipWithGroupRef>): boolean
}

export type WorkflowValidationError =
  | "name_empty"
  | "name_too_long"
  | "name_invalid_characters"
  | "description_too_long"
  | "update_before_create"
  | "status_invalid"
  | "workflow_template_id_invalid_uuid"

export class WorkflowFactory {
  /**
   * Validates an existing Workflow object.
   * @param data The Workflow object to validate.
   * @returns Either a validation error or the valid Workflow object.
   */
  static validate(
    data: Parameters<typeof WorkflowFactory.instantiateWorkflow>[0]
  ): Either<WorkflowValidationError, Workflow> {
    return WorkflowFactory.instantiateWorkflow(data)
  }

  static validateWithTemplate(
    data: Parameters<typeof WorkflowFactory.instantiateWorkflowWithTemplate>[0]
  ): Either<WorkflowValidationError, WorkflowWithTemplate> {
    return WorkflowFactory.instantiateWorkflowWithTemplate(data)
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
  private static instantiateWorkflow(
    data: Omit<WorkflowData, "status"> & {
      status: string
    }
  ): Either<WorkflowValidationError, Workflow> {
    const nameValidation = validateWorkflowName(data.name)
    const descriptionValidation = data.description ? validateWorkflowDescription(data.description) : right(undefined)
    const statusValidation = validateWorkflowStatus(data.status)

    if (!isUUIDv4(data.workflowTemplateId)) return left("workflow_template_id_invalid_uuid")
    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (data.createdAt > data.updatedAt) return left("update_before_create")
    if (isLeft(statusValidation)) return statusValidation

    const workflowData = {
      ...data,
      name: nameValidation.right,
      description: descriptionValidation.right,
      status: data.recalculationRequired ? WorkflowStatus.EVALUATION_IN_PROGRESS : statusValidation.right
    }

    return right({
      ...workflowData,
      evaluateStatus: (votes: ReadonlyArray<Vote>) => evaluateStatus(workflowData, votes)
    })
  }

  private static instantiateWorkflowWithTemplate(
    data: Omit<WorkflowDataWithTemplate, "status"> & {
      status: string
    }
  ): Either<WorkflowValidationError, WorkflowWithTemplate> {
    const workflow = WorkflowFactory.instantiateWorkflow(data)
    if (isLeft(workflow)) return workflow

    const workflowWithTemplateData = {
      ...workflow.right,
      workflowTemplateRef: data.workflowTemplateRef
    }

    return right({
      ...workflowWithTemplateData,
      canVote: (memberships: ReadonlyArray<MembershipWithGroupRef>) => canVote(workflowWithTemplateData, memberships)
    })
  }
}

function canVote(workflow: WorkflowDataWithTemplate, memberships: ReadonlyArray<MembershipWithGroupRef>): boolean {
  if (workflow.status === WorkflowStatus.CANCELED || workflow.status === WorkflowStatus.APPROVED) return false
  return workflow.workflowTemplateRef.canVote(memberships)
}

function evaluateStatus(
  workflow: WorkflowData,
  votes: ReadonlyArray<Vote>,
  template?: WorkflowTemplate
): Either<WorkflowValidationError, Workflow> {
  // After a workflow has been approved, it's not possible to change its status
  if (workflow.status === WorkflowStatus.APPROVED || workflow.status === WorkflowStatus.CANCELED)
    return changeStatusAndMarkAsRecalculated(workflow, workflow.status)

  if (!template) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.PENDING)

  const votesConsolidated = consolidateVotes(votes)
  const votesAgainst = votesConsolidated.filter(vote => vote.type === "VETO")
  const votesFor = votesConsolidated.filter(vote => vote.type === "APPROVE")

  if (votesConsolidated.length === 0) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.PENDING)

  if (votesAgainst.length > 0) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.REJECTED)

  if (doesVotesCoverApprovalRules(template.approvalRule, votesFor))
    return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.APPROVED)

  return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.PENDING)
}

function changeStatusAndMarkAsRecalculated(
  workflow: WorkflowData,
  status: WorkflowStatus
): Either<WorkflowValidationError, Workflow> {
  return WorkflowFactory.validate({...workflow, status, recalculationRequired: false})
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
