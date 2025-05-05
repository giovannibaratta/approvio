import {ApprovalRule, Workflow, WorkflowValidationError} from "@domain"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {TaskEither} from "fp-ts/TaskEither"

export type CreateWorkflowRepoError = UnknownError | "workflow_already_exists"
export type CreateWorkflowRepo = {
  workflow: Workflow
}

export const WORKFLOW_REPOSITORY_TOKEN = Symbol("WORKFLOW_REPOSITORY_TOKEN")
export interface WorkflowRepository {
  createWorkflow(data: CreateWorkflowRepo): TaskEither<CreateWorkflowRepoError | WorkflowValidationError, Workflow>
}

export type CreateWorkflowError = WorkflowValidationError | CreateWorkflowRepoError

export interface CreateWorkflowRequest extends RequestorAwareRequest {
  workflowData: {
    name: string
    description?: string
    rule: ApprovalRule
  }
}
