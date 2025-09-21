import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {ApprovalRule, ApprovalRuleFactory, ApprovalRuleValidationError} from "./approval-rules"
import {WorkflowAction, WorkflowActionValidationError, validateWorkflowActions} from "./workflow-actions"
import {MembershipWithGroupRef, UnconstrainedBoundRole} from "@domain"
import {PrefixUnion, getStringAsEnum} from "@utils"

export const WORKFLOW_TEMPLATE_NAME_MAX_LENGTH = 512
export const WORKFLOW_TEMPLATE_DESCRIPTION_MAX_LENGTH = 2048
export const MAX_EXPIRES_IN_HOURS = 8760 // 1 year

/**
 * Workflow template lifecycle status.
 */
export enum WorkflowTemplateStatus {
  /**
   * Template can be referenced to create new workflows.
   */
  ACTIVE = "ACTIVE",
  /**
   * Template has been deprecated but there are still active workflows.
   * Cannot be referenced for new workflows. This intermediate status is used internally
   * to handle the deprecation asynchronously if the user requested the cancellation of the active
   * workflows.
   */
  PENDING_DEPRECATION = "PENDING_DEPRECATION",
  /**
   * Template cannot be referenced for new workflows. Voting may still be allowed
   * depending on user settings when deprecation was requested.
   */
  DEPRECATED = "DEPRECATED"
}

export type WorkflowTemplate = Readonly<WorkflowTemplateData & WorkflowTemplateLogic>

interface WorkflowTemplateData {
  id: string
  name: string
  version: number | "latest"
  description?: string
  approvalRule: ApprovalRule
  actions: ReadonlyArray<WorkflowAction>
  defaultExpiresInHours?: number
  status: WorkflowTemplateStatus
  allowVotingOnDeprecatedTemplate: boolean
  createdAt: Date
  updatedAt: Date
}

export type WorkflowTemplateSummary = Pick<
  WorkflowTemplateData,
  "id" | "name" | "version" | "description" | "createdAt" | "updatedAt"
>

export type WorkflowTemplateCantVoteReason =
  | "entity_not_in_required_group"
  | "workflow_template_not_active"
  | "entity_not_eligible_to_vote"

interface WorkflowTemplateLogic {
  canVote(
    memberships: ReadonlyArray<MembershipWithGroupRef>,
    entityRoles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<WorkflowTemplateCantVoteReason, true>
}

export type WorkflowTemplateValidationError =
  | PrefixUnion<"workflow_template", UnprefixedWorkflowTemplateValidationError>
  | ApprovalRuleValidationError
  | WorkflowActionValidationError

type UnprefixedWorkflowTemplateValidationError =
  | "name_empty"
  | "name_too_long"
  | "name_invalid_characters"
  | "description_too_long"
  | "update_before_create"
  | "expires_in_hours_invalid"
  | "status_invalid"
  | "version_invalid_number"
  | "version_too_long"
  | "version_invalid_format"
  | "active_is_not_latest"

export type WorkflowTemplateDeprecationError =
  | "workflow_template_not_active"
  | "workflow_template_not_pending_deprecation"

type UserModifiableAttributes = Pick<
  WorkflowTemplate,
  "actions" | "approvalRule" | "defaultExpiresInHours" | "description"
>

export class WorkflowTemplateFactory {
  /**
   * Validates partial attributes for workflow template updates.
   * Only validates attributes that are defined in the partial object.
   * @param partialData Partial workflow template data to validate.
   * @returns Either a validation error or void if valid.
   */
  static validateAttributes(
    partialData: Partial<UserModifiableAttributes>
  ): Either<WorkflowTemplateValidationError, Partial<UserModifiableAttributes>> {
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

    return right({
      ...(partialData.description && {description: partialData.description}),
      ...(partialData.approvalRule && {approvalRule: partialData.approvalRule}),
      ...(partialData.actions && {actions: partialData.actions}),
      ...(partialData.defaultExpiresInHours && {defaultExpiresInHours: partialData.defaultExpiresInHours})
    })
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
    data: Omit<
      Parameters<typeof WorkflowTemplateFactory.validate>[0],
      "id" | "createdAt" | "updatedAt" | "deletedAt" | "status" | "allowVotingOnDeprecatedTemplate" | "version"
    >
  ): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
    const uuid = randomUUID()
    const now = new Date()
    const template = {
      ...data,
      id: uuid,
      version: "latest" as const,
      status: WorkflowTemplateStatus.ACTIVE,
      allowVotingOnDeprecatedTemplate: true,
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
    data: Omit<WorkflowTemplateData, "approvalRule" | "actions" | "status"> & {
      approvalRule: unknown
      actions: unknown
      status: string
    }
  ): Either<WorkflowTemplateValidationError, WorkflowTemplate> {
    const nameValidation = validateWorkflowTemplateName(data.name)
    const versionValidation = validateWorkflowTemplateVersion(data.version)
    const descriptionValidation = data.description
      ? validateWorkflowTemplateDescription(data.description)
      : right(undefined)
    const ruleValidation = ApprovalRuleFactory.validate(data.approvalRule)
    const actionsValidation = validateWorkflowActions(data.actions)
    const expiresValidation =
      data.defaultExpiresInHours !== undefined ? validateExpiresInHours(data.defaultExpiresInHours) : right(undefined)
    const statusValidation = validateWorkflowTemplateStatus(data.status)

    if (isLeft(nameValidation)) return nameValidation
    if (isLeft(versionValidation)) return versionValidation
    if (isLeft(descriptionValidation)) return descriptionValidation
    if (isLeft(ruleValidation)) return ruleValidation
    if (isLeft(actionsValidation)) return actionsValidation
    if (isLeft(expiresValidation)) return expiresValidation
    if (isLeft(statusValidation)) return statusValidation
    if (data.createdAt > data.updatedAt) return left("workflow_template_update_before_create")
    if (statusValidation.right === WorkflowTemplateStatus.ACTIVE && versionValidation.right !== "latest")
      return left("workflow_template_active_is_not_latest")
    if (versionValidation.right === "latest" && statusValidation.right !== WorkflowTemplateStatus.ACTIVE)
      return left("workflow_template_active_is_not_latest")

    const workflowTemplateData: WorkflowTemplateData = {
      ...data,
      name: nameValidation.right,
      version: versionValidation.right,
      description: descriptionValidation.right,
      approvalRule: ruleValidation.right,
      actions: actionsValidation.right,
      defaultExpiresInHours: expiresValidation.right,
      status: statusValidation.right
    }

    return right({
      ...workflowTemplateData,
      canVote: (
        memberships: ReadonlyArray<MembershipWithGroupRef>,
        entityRoles: ReadonlyArray<UnconstrainedBoundRole>
      ) => canVote(workflowTemplateData, memberships, entityRoles)
    })
  }
}

function validateWorkflowTemplateName(name: string): Either<WorkflowTemplateValidationError, string> {
  if (!name || name.trim().length === 0) return E.left("workflow_template_name_empty")
  if (name.length > WORKFLOW_TEMPLATE_NAME_MAX_LENGTH) return E.left("workflow_template_name_too_long")
  // String must start and end with a letter or number
  // String can only contain letters, numbers, hyphens and spaces
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-\s]+[a-zA-Z0-9]$/.test(name))
    return E.left("workflow_template_name_invalid_characters")

  return E.right(name)
}

function validateWorkflowTemplateDescription(description: string): Either<WorkflowTemplateValidationError, string> {
  if (description.length > WORKFLOW_TEMPLATE_DESCRIPTION_MAX_LENGTH)
    return E.left("workflow_template_description_too_long")

  return E.right(description)
}

function validateExpiresInHours(hours: unknown): Either<WorkflowTemplateValidationError, number> {
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_EXPIRES_IN_HOURS) {
    return left("workflow_template_expires_in_hours_invalid")
  }

  return right(hours)
}

function validateWorkflowTemplateStatus(
  status: string
): Either<WorkflowTemplateValidationError, WorkflowTemplateStatus> {
  const enumStatus = getStringAsEnum(status, WorkflowTemplateStatus)
  if (enumStatus === undefined) return left("workflow_template_status_invalid")
  return right(enumStatus)
}

function validateWorkflowTemplateVersion(
  version: string | number
): Either<WorkflowTemplateValidationError, WorkflowTemplate["version"]> {
  if (version === "latest") return E.right("latest" as const)

  // Version can be either a string representing a number, or a number itself. Other cases are not allowed
  let value: number

  if (typeof version === "string")
    try {
      value = parseInt(version)
    } catch {
      return E.left("workflow_template_version_invalid_format")
    }
  else value = version

  return value < 0 ? E.left("workflow_template_version_invalid_number") : E.right(value)
}

function canVote(
  workflowTemplate: WorkflowTemplateData,
  memberships: ReadonlyArray<MembershipWithGroupRef>,
  entityRoles: ReadonlyArray<UnconstrainedBoundRole>
): Either<WorkflowTemplateCantVoteReason, true> {
  if (workflowTemplate.status !== WorkflowTemplateStatus.ACTIVE && !workflowTemplate.allowVotingOnDeprecatedTemplate) {
    return left("workflow_template_not_active")
  }

  // Check if entity has vote permission for this workflow template
  const hasVotePermission = hasVotePermissionForWorkflowTemplate(workflowTemplate.id, entityRoles)
  if (!hasVotePermission) return left("entity_not_eligible_to_vote")

  const votingGroups = workflowTemplate.approvalRule.getVotingGroupIds()

  // Is it possible to vote if at least one of the membership group is listed in approval rules
  const hasValidMembership = memberships.some(membership => votingGroups.includes(membership.groupId))

  if (!hasValidMembership) return left("entity_not_in_required_group")

  return right(true)
}

function hasVotePermissionForWorkflowTemplate(
  workflowTemplateId: string,
  entityRoles: ReadonlyArray<UnconstrainedBoundRole>
): boolean {
  return entityRoles.some(
    role =>
      role.permissions.includes("vote") &&
      role.scope.type === "workflow_template" &&
      role.scope.workflowTemplateId === workflowTemplateId
  )
}

/**
 * Marks a template for deprecation by transitioning it to PENDING_DEPRECATION status.
 * @param template The active workflow template to deprecate
 * @param newVersion The new version number for the deprecated template.
 *                   Required because only one template can have "latest" version (ACTIVE status),
 *                   so the deprecated template must be assigned a specific version number.
 * @param cancelWorkflows Whether to cancel active workflows using this template.
 *                        If false, voting remains allowed on deprecated template.
 * @returns The updated template with PENDING_DEPRECATION status or validation errors
 */
export function markTemplateForDeprecation(
  template: WorkflowTemplate,
  newVersion: number,
  cancelWorkflows: boolean
): Either<WorkflowTemplateValidationError | WorkflowTemplateDeprecationError, WorkflowTemplate> {
  if (template.status !== WorkflowTemplateStatus.ACTIVE) return E.left("workflow_template_not_active")

  const updatedTemplate: WorkflowTemplate = {
    ...template,
    version: newVersion,
    status: WorkflowTemplateStatus.PENDING_DEPRECATION,
    allowVotingOnDeprecatedTemplate: !cancelWorkflows,
    updatedAt: new Date()
  }

  return WorkflowTemplateFactory.validate(updatedTemplate)
}

export function markTemplateAsDeprecated(
  template: WorkflowTemplate
): Either<WorkflowTemplateValidationError | WorkflowTemplateDeprecationError, WorkflowTemplate> {
  if (template.status !== WorkflowTemplateStatus.PENDING_DEPRECATION) {
    return left("workflow_template_not_pending_deprecation")
  }

  const updatedTemplate = {
    ...template,
    status: WorkflowTemplateStatus.DEPRECATED,
    updatedAt: new Date()
  }

  return WorkflowTemplateFactory.validate(updatedTemplate)
}

export function getMostRecentVersionFromTuples<T>(
  tuples: ReadonlyArray<T & {version: string}>
): Either<"empty_array" | "invalid_version", T> {
  if (tuples.length === 0) return left("empty_array")

  try {
    const mostRecent = tuples.reduce((mostRecent, current) => {
      if (current.version === "latest") return current
      if (mostRecent.version === "latest") return mostRecent

      const currentVersionNum = parseInt(current.version, 10)
      const mostRecentVersionNum = parseInt(mostRecent.version, 10)

      if (isNaN(currentVersionNum) || isNaN(mostRecentVersionNum)) {
        throw new Error("Invalid version format")
      }

      return currentVersionNum > mostRecentVersionNum ? current : mostRecent
    })

    return right(mostRecent)
  } catch {
    return left("invalid_version")
  }
}
