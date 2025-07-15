import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {DecorableEntity, getStringAsEnum, isDecoratedWith, isUUIDv4, PrefixUnion} from "@utils"
import {MembershipWithGroupRef, Vote, consolidateVotes, doesVotesCoverApprovalRules} from "@domain"
import {WorkflowTemplate, WorkflowTemplateCantVoteReason} from "./workflow-templates"

export const WORKFLOW_NAME_MAX_LENGTH = 512
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 2048

export enum WorkflowStatus {
  APPROVED = "APPROVED",
  CANCELED = "CANCELED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
  EVALUATION_IN_PROGRESS = "EVALUATION_IN_PROGRESS"
}

export type CantVoteReason =
  | "workflow_already_approved"
  | "workflow_cancelled"
  | "workflow_expired"
  | WorkflowTemplateCantVoteReason

export type Workflow = Readonly<WorkflowData>

interface WorkflowData {
  id: string
  name: string
  description?: string
  status: WorkflowStatus
  recalculationRequired: boolean
  workflowTemplateId: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export type WorkflowValidationError = PrefixUnion<"workflow", UnprefixedWorkflowValidationError>

type UnprefixedWorkflowValidationError =
  | "name_empty"
  | "name_too_long"
  | "name_invalid_characters"
  | "description_too_long"
  | "update_before_create"
  | "status_invalid"
  | "workflow_template_id_invalid_uuid"
  | "expires_at_in_the_past"

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
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
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

    if (!isUUIDv4(data.workflowTemplateId)) return left("workflow_workflow_template_id_invalid_uuid")
    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (data.createdAt > data.updatedAt) return left("workflow_update_before_create")
    if (data.expiresAt < data.createdAt) return left("workflow_expires_at_in_the_past")
    if (isLeft(statusValidation)) return statusValidation

    const workflowData = {
      ...data,
      name: nameValidation.right,
      description: descriptionValidation.right,
      status: data.recalculationRequired ? WorkflowStatus.EVALUATION_IN_PROGRESS : statusValidation.right
    }

    return right(workflowData)
  }
}

export const WORKFLOW_TERMINAL_STATUSES = [WorkflowStatus.APPROVED, WorkflowStatus.CANCELED, WorkflowStatus.EXPIRED]

export function canVoteOnWorkflow(
  workflow: DecoratedWorkflow<{workflowTemplate: true}>,
  memberships: ReadonlyArray<MembershipWithGroupRef>
): Either<CantVoteReason, true> {
  if (WORKFLOW_TERMINAL_STATUSES.includes(workflow.status))
    return left(generateCantVoteReasonForTerminalStatus(workflow.status))

  // Check if workflow has expired
  const now = new Date(Date.now())
  if (workflow.expiresAt < now) return left("workflow_expired")

  const templateCanVoteResult = workflow.workflowTemplate.canVote(memberships)
  if (isLeft(templateCanVoteResult)) return templateCanVoteResult

  return right(true)
}

function generateCantVoteReasonForTerminalStatus(status: WorkflowStatus): CantVoteReason {
  switch (status) {
    case WorkflowStatus.APPROVED:
      return "workflow_already_approved"
    case WorkflowStatus.CANCELED:
      return "workflow_cancelled"
    case WorkflowStatus.EXPIRED:
      return "workflow_expired"
    default:
      throw new Error(`Invalid terminal status: ${status}`)
  }
}

export function evaluateWorkflowStatus(
  workflow: DecoratedWorkflow<{workflowTemplate: true}>,
  votes: ReadonlyArray<Vote>
): Either<WorkflowValidationError, Workflow> {
  const now = new Date(Date.now())

  // After a workflow has reached a terminal status, it's not possible to change its status
  if (WORKFLOW_TERMINAL_STATUSES.includes(workflow.status))
    return changeStatusAndMarkAsRecalculated(workflow, workflow.status)
  if (workflow.expiresAt < now) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.EXPIRED)

  const votesConsolidated = consolidateVotes(votes)
  const votesAgainst = votesConsolidated.filter(vote => vote.type === "VETO")
  const votesFor = votesConsolidated.filter(vote => vote.type === "APPROVE")

  if (votesConsolidated.length === 0)
    return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.EVALUATION_IN_PROGRESS)

  if (votesAgainst.length > 0) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.REJECTED)

  if (doesVotesCoverApprovalRules(workflow.workflowTemplate.approvalRule, votesFor))
    return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.APPROVED)

  return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.EVALUATION_IN_PROGRESS)
}

function changeStatusAndMarkAsRecalculated(
  workflow: WorkflowData,
  status: WorkflowStatus
): Either<WorkflowValidationError, Workflow> {
  return WorkflowFactory.validate({...workflow, status, recalculationRequired: false})
}

function validateWorkflowName(name: string): Either<WorkflowValidationError, string> {
  if (!name || name.trim().length === 0) return E.left("workflow_name_empty")
  if (name.length > WORKFLOW_NAME_MAX_LENGTH) return E.left("workflow_name_too_long")
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return E.left("workflow_name_invalid_characters")

  return E.right(name)
}

function validateWorkflowDescription(description: string): Either<WorkflowValidationError, string> {
  if (description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH) return E.left("workflow_description_too_long")

  return E.right(description)
}

function validateWorkflowStatus(status: string): Either<WorkflowValidationError, WorkflowStatus> {
  const enumStatus = getStringAsEnum(status, WorkflowStatus)
  if (enumStatus === undefined) return left("workflow_status_invalid")
  return right(enumStatus)
}

export interface WorkflowDecorators {
  workflowTemplate: WorkflowTemplate
  occ: bigint
}

export type WorkflowDecoratorSelector = Partial<Record<keyof WorkflowDecorators, boolean>>

export type DecoratedWorkflow<T extends WorkflowDecoratorSelector> = DecorableEntity<Workflow, WorkflowDecorators, T>

export function isDecoratedWorkflow<K extends keyof WorkflowDecorators>(
  workflow: DecoratedWorkflow<WorkflowDecoratorSelector>,
  key: K,
  options?: WorkflowDecoratorSelector
): workflow is DecoratedWorkflow<WorkflowDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<
    DecoratedWorkflow<WorkflowDecoratorSelector>,
    WorkflowDecorators,
    WorkflowDecoratorSelector,
    keyof WorkflowDecorators
  >(workflow, key, options)
}
