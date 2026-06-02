import {
  DecoratedWorkflow,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowTemplateValidationError,
  WorkflowValidationError
} from "@domain"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {TaskEither} from "fp-ts/TaskEither"

export interface WorkflowRepository {
  createWorkflow(
    data: CreateWorkflowRepo
  ): TaskEither<CreateWorkflowRepoError | WorkflowValidationError | WorkflowTemplateValidationError, Workflow>

  /**
   * Get a workflow by its id.
   * @param workflowId The id of the workflow to get.
   * @param includeRef The properties to include in the response.
   * @returns A TaskEither with the workflow or an error.
   */
  getWorkflowById<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>>

  /**
   * Get a workflow by its name.
   * @param workflowName The name of the workflow to get.
   * @param includeRef The properties to include in the response.
   * @returns A TaskEither with the workflow or an error.
   */
  getWorkflowByName<T extends WorkflowDecoratorSelector>(
    workflowName: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>>

  /**
   * List workflows.
   * @param request The request containing the pagination and the properties to include in the response.
   * @returns A TaskEither with the workflows or an error.
   */
  listWorkflows<TInclude extends WorkflowDecoratorSelector>(
    request: ListWorkflowsRequestRepo<TInclude>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponse<TInclude>>

  /**
   * Update a workflow. Since the OCC check is not performed, this method should only be used for properties
   * that can be updated concurrently without risk of data corruption.
   * @param workflowId The id of the workflow to update.
   * @param data The data to update the workflow with.
   * @param includeRef The properties to include in the response.
   * @returns A TaskEither with the updated workflow or an error.
   */
  updateWorkflow<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>

  /**
   * Update a workflow. OCC check is performed before updating the workflow, hence this is always safe to use.
   * In case a concurrent update is detected, the error is returned without modifying the workflow.
   * @param workflowId The id of the workflow to update.
   * @param occCheck The OCC value used to validate the workflow is still in the expected state.
   * @param data The data to update the workflow with.
   * @param includeRef The properties to include in the response.
   * @returns A TaskEither with the updated workflow or an error.
   */
  updateWorkflowConcurrentSafe<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>

  countActiveWorkflowsByTemplateId(templateId: string): TaskEither<UnknownError, number>
  countActiveWorkflows(): TaskEither<UnknownError, number>
  getParentWorkflowTemplate(workflowId: string): TaskEither<WorkflowGetParentTemplateError, string>

  /**
   * Finds the IDs of expired workflows that are not in a terminal state and have not been enqueued.
   * @param now Current date to compare against workflow expiresAt.
   * @param limit Maximum number of records to return per batch.
   * @returns A TaskEither with an array of workflow IDs or an error.
   */
  findExpiredWorkflows(now: Date, limit?: number): TaskEither<UnknownError, string[]>

  /**
   * Marks a list of workflows as pending recalculation.
   * Note: This method intentionally skips the OCC check and does not increment the OCC counter.
   * This is because setting the `recalculationRequired` flag is a safe, idempotent operation
   * that merely signals a background job needs to re-evaluate the workflow. Skipping OCC
   * prevents the sweep job from failing due to race conditions with concurrent active votes.
   * @param workflowIds The IDs of the workflows to mark.
   * @returns A TaskEither indicating success or failure.
   */
  markWorkflowsAsRecalculationRequired(workflowIds: string[]): TaskEither<UnknownError, void>
}

export type WorkflowGetParentTemplateError = "workflow_not_found" | UnknownError

export type WorkflowGetError =
  | "workflow_not_found"
  | WorkflowValidationError
  | WorkflowTemplateValidationError
  | UnknownError

export type WorkflowUpdateError =
  | "workflow_not_found"
  | "concurrency_error"
  | WorkflowValidationError
  | WorkflowTemplateValidationError
  | UnknownError

export type CreateWorkflowRepoError = UnknownError | "workflow_already_exists"
export type CreateWorkflowRepo = {
  workflow: Workflow
}

export type CreateWorkflowError =
  | WorkflowValidationError
  | WorkflowTemplateValidationError
  | CreateWorkflowRepoError
  | "quota_exceeded"
  | "quota_check_error"

export interface CreateWorkflowRequest extends RequestorAwareRequest {
  workflowData: {
    name: string
    description?: string
    workflowTemplateId: string
  }
}

export type ConcurrentSafeWorkflowUpdateData = Pick<Workflow, "recalculationRequired">
export type ConcurrentUnsafeWorkflowUpdateData = Partial<Pick<Workflow, "status" | "recalculationRequired">> &
  Pick<Workflow, "updatedAt">

export type WorkflowSortParam = "createdAt" | "updatedAt"
export type SortOrder = "asc" | "desc"

export interface WorkflowSort {
  param: WorkflowSortParam
  order: SortOrder
}

export interface ListWorkflowsRequestRepo<TInclude extends WorkflowDecoratorSelector> {
  pagination?: {
    page: number
    limit: number
  }
  include?: TInclude
  sort?: WorkflowSort[]
  filters?: {
    includeOnlyNonTerminalState?: boolean
    templateId?: string
    workflowTemplateId?: string
    workflowTemplateName?: string
    includeGroups?: string[]
  }
}

export interface ListWorkflowsRequest<TInclude extends WorkflowDecoratorSelector>
  extends RequestorAwareRequest, Omit<ListWorkflowsRequestRepo<TInclude>, "filters" | "sort"> {
  filters?: {
    includeOnlyNonTerminalState?: boolean
    workflowTemplateIdentifier?: string
    includeGroups?: string[]
  }
  sort?: WorkflowSort[]
}

export interface ListWorkflowsResponse<TInclude extends WorkflowDecoratorSelector> {
  workflows: ReadonlyArray<DecoratedWorkflow<TInclude>>
  pagination: {
    total: number
    page: number
    limit: number
  }
}

export const WORKFLOW_REPOSITORY_TOKEN = Symbol("WORKFLOW_REPOSITORY_TOKEN")
