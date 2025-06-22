import {Workflow, WorkflowTemplate, WorkflowTemplateValidationError, WorkflowValidationError} from "@domain"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {DecorableEntity, isDecoratedWith} from "@utils"
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
    request: ListWorkflowsRequest<TInclude>
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
}

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

export type CreateWorkflowError = WorkflowValidationError | WorkflowTemplateValidationError | CreateWorkflowRepoError

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

export interface ListWorkflowsRequest<TInclude extends WorkflowDecoratorSelector> extends RequestorAwareRequest {
  pagination: {
    page: number
    limit: number
  }
  include?: TInclude
}

export interface ListWorkflowsResponse<TInclude extends WorkflowDecoratorSelector> {
  workflows: ReadonlyArray<DecoratedWorkflow<TInclude>>
  pagination: {
    total: number
    page: number
    limit: number
  }
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

export const WORKFLOW_REPOSITORY_TOKEN = Symbol("WORKFLOW_REPOSITORY_TOKEN")
