import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/Either"
import {DecorableEntity, getStringAsEnum, isDecoratedWith, isUUIDv7, PrefixUnion} from "@utils"
import {
  MembershipWithGroupRef,
  Vote,
  doesVotesCoverApprovalRules,
  UnconstrainedBoundRole,
  Versioned,
  getNormalizedEntityId
} from "@domain"
import {WorkflowTemplate, WorkflowTemplateCantVoteReason} from "./workflow-templates"
import {v7 as uuidv7} from "uuid"

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
    const uuid = uuidv7()
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

    if (!isUUIDv7(data.workflowTemplateId)) return left("workflow_workflow_template_id_invalid_uuid")
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
  memberships: ReadonlyArray<MembershipWithGroupRef>,
  entityRoles: ReadonlyArray<UnconstrainedBoundRole>,
  votedForGroups?: ReadonlyArray<string>
): Either<CantVoteReason | "inconsistent_memberships", {canVote: true; requireHighPrivilege: boolean}> {
  if (WORKFLOW_TERMINAL_STATUSES.includes(workflow.status))
    return left(generateCantVoteReasonForTerminalStatus(workflow.status))

  // Check if workflow has expired
  const now = new Date(Date.now())
  if (workflow.expiresAt < now) return left("workflow_expired")

  const templateCanVoteResult = workflow.workflowTemplate.canVote(memberships, entityRoles, votedForGroups)
  if (isLeft(templateCanVoteResult)) return templateCanVoteResult

  return templateCanVoteResult
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

/**
 * Evaluates the status of a workflow based on its votes.
 *
 * DESIGN APPROACH: Chronological Sequential State-Machine (Event Log)
 * To prevent write-after-read race conditions (where an approval at t1 is concurrently
 * accompanied by a veto at t2, and an out-of-order execution or OCC retry evaluates both
 * together), we play the votes chronologically:
 *
 * 1. Votes are sorted in ascending order of their `castedAt` timestamp.
 * 2. If two votes have identical timestamps, we prioritize VETO over APPROVE for safety.
 * 3. We iterate over the votes sequentially, accumulating them in an incremental state.
 * 4. As soon as a terminal state (APPROVED) is reached, we halt processing immediately.
 *    Any subsequent votes in the timeline are ignored because the workflow is already closed.
 * 5. A REJECTED state (due to a veto) is non-terminal, as a subsequent WITHDRAW vote
 *    could return the status back to progress.
 *
 * @param workflow The workflow to evaluate, decorated with its template.
 * @param votes All votes cast for this workflow.
 * @returns Either a validation error or the workflow with its updated status.
 */
export function evaluateWorkflowStatus(
  workflow: DecoratedWorkflow<{workflowTemplate: true}>,
  votes: ReadonlyArray<Vote>
): Either<WorkflowValidationError, Workflow> {
  const now = new Date()

  if (WORKFLOW_TERMINAL_STATUSES.includes(workflow.status))
    return changeStatusAndMarkAsRecalculated(workflow, workflow.status)

  if (workflow.expiresAt < now) return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.EXPIRED)

  // 1. Sort all votes in ascending order of their castedAt timestamp (chronological timeline)
  const votesSortedAsc = [...votes].sort((a, b) => {
    const timeDiff = a.castedAt.getTime() - b.castedAt.getTime()
    if (timeDiff !== 0) return timeDiff

    // If timestamps are identical, prioritize VETO over other votes
    if (a.type === "VETO" && b.type !== "VETO") return -1
    if (b.type === "VETO" && a.type !== "VETO") return 1
    return 0
  })

  // 2. Play the votes sequentially through time
  const activeVoters = new Map<string, Vote>()
  const groupVoters = new Map<string, Set<string>>()
  const activeVetoers = new Set<string>()

  let currentStatus = WorkflowStatus.EVALUATION_IN_PROGRESS

  for (const vote of votesSortedAsc) {
    const voterKey = getNormalizedEntityId(vote.voter)
    const previousVote = activeVoters.get(voterKey)

    // 2.1 Remove effects of the previous vote if it existed.
    // A user's new vote (of any type) completely overrides their previous state in the timeline.
    if (previousVote)
      if (previousVote.type === "VETO") activeVetoers.delete(voterKey)
      else if (previousVote.type === "APPROVE")
        for (const groupId of previousVote.votedForGroups) groupVoters.get(groupId)?.delete(voterKey)

    // 2.2 Apply the new vote
    activeVoters.set(voterKey, vote)
    if (vote.type === "VETO") activeVetoers.add(voterKey)
    else if (vote.type === "APPROVE")
      for (const groupId of vote.votedForGroups) {
        if (!groupVoters.has(groupId)) groupVoters.set(groupId, new Set())
        groupVoters.get(groupId)!.add(voterKey)
      }
    else if (vote.type === "WITHDRAW") activeVoters.delete(voterKey)

    // 2.3 Evaluate state for this point in time
    if (activeVetoers.size > 0) currentStatus = WorkflowStatus.REJECTED
    else if (doesVotesCoverApprovalRules(workflow.workflowTemplate.approvalRule, groupVoters))
      // Terminal state APPROVED reached! Stop playing subsequent votes.

      return changeStatusAndMarkAsRecalculated(workflow, WorkflowStatus.APPROVED)
    else currentStatus = WorkflowStatus.EVALUATION_IN_PROGRESS
  }

  // 3. Fallback check for expired status if no terminal status was reached
  if (currentStatus === WorkflowStatus.EVALUATION_IN_PROGRESS && workflow.expiresAt < now)
    currentStatus = WorkflowStatus.EXPIRED

  return changeStatusAndMarkAsRecalculated(workflow, currentStatus)
}

function changeStatusAndMarkAsRecalculated(
  workflow: WorkflowData,
  status: WorkflowStatus
): Either<WorkflowValidationError, Workflow> {
  return WorkflowFactory.validate({...workflow, status, recalculationRequired: false, updatedAt: new Date()})
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
  workflowTemplate: Versioned<WorkflowTemplate>
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
