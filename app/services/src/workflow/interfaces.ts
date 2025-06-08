import {ApprovalRule, Workflow, WorkflowValidationError} from "@domain"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {TaskEither} from "fp-ts/TaskEither"
import {Versioned} from "@services/shared/utils"

export type CreateWorkflowRepoError = UnknownError | "workflow_already_exists"
export type CreateWorkflowRepo = {
  workflow: Workflow
}

export const WORKFLOW_REPOSITORY_TOKEN = Symbol("WORKFLOW_REPOSITORY_TOKEN")

export type WorkflowGetError = "workflow_not_found" | WorkflowValidationError | UnknownError
export type WorkflowUpdateError = "workflow_not_found" | "concurrency_error" | UnknownError | WorkflowValidationError

export interface WorkflowRepository {
  createWorkflow(data: CreateWorkflowRepo): TaskEither<CreateWorkflowRepoError | WorkflowValidationError, Workflow>
  getWorkflowById(workflowId: string): TaskEither<WorkflowGetError, Versioned<Workflow>>
  getWorkflowByName(workflowName: string): TaskEither<WorkflowGetError, Versioned<Workflow>>
  /**
   * These updates can be performed concurrently. The OCC check is not performed.
   */
  updateWorkflow(
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData
  ): TaskEither<WorkflowUpdateError, Versioned<Workflow>>
  /**
   * These updates cannot be performed concurrently. The OCC check is performed to validate that
   * the workflow is still in the expected state.
   */
  updateWorkflowConcurrentSafe(
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData
  ): TaskEither<WorkflowUpdateError, Versioned<Workflow>>
}

export type CreateWorkflowError = WorkflowValidationError | CreateWorkflowRepoError

export interface CreateWorkflowRequest extends RequestorAwareRequest {
  workflowData: {
    name: string
    description?: string
    rule: ApprovalRule
  }
}

export type ConcurrentSafeWorkflowUpdateData = Pick<Workflow, "recalculationRequired">
export type ConcurrentUnsafeWorkflowUpdateData = Partial<Pick<Workflow, "status" | "recalculationRequired">> &
  Pick<Workflow, "updatedAt">
