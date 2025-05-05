import {randomUUID} from "crypto"
import * as E from "fp-ts/Either"
import {Either, isLeft, left, right} from "fp-ts/lib/Either"
import {ApprovalRule, ApprovalRuleFactory, ApprovalRuleValidationError} from "./approval-rules"
import {getStringAsEnum} from "@utils"

export const WORKFLOW_NAME_MAX_LENGTH = 512
export const WORKFLOW_DESCRIPTION_MAX_LENGTH = 2048

export enum WorkflowStatus {
  EVALUATION_IN_PROGRESS = "EVALUATION_IN_PROGRESS",
  EVALUATION_COMPLETED = "EVALUATION_COMPLETED"
}

export type Workflow = Readonly<PrivateWorkflow>

interface PrivateWorkflow {
  id: string
  name: string
  description?: string
  rule: ApprovalRule
  status: WorkflowStatus
  createdAt: Date
  updatedAt: Date
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
    data: Omit<Workflow, "status" | "rule"> & {
      status: string
      rule: unknown
    }
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
    data: Omit<Parameters<typeof WorkflowFactory.validate>[0], "id" | "createdAt" | "updatedAt" | "status">
  ): Either<WorkflowValidationError, Workflow> {
    const uuid = randomUUID()
    const now = new Date()
    const workflow = {
      ...data,
      id: uuid,
      status: WorkflowStatus.EVALUATION_IN_PROGRESS,
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
    data: Parameters<typeof WorkflowFactory.validate>[0]
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

    return right({
      ...data,
      name: nameValidation.right,
      description: descriptionValidation.right,
      rule: ruleValidation.right,
      status: statusValidation.right
    })
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
