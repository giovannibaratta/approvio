import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  ApprovalRule,
  WorkflowAction,
  WorkflowTemplateSummary
} from "@domain"
import {UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {TaskEither} from "fp-ts/TaskEither"
import {Option} from "fp-ts/Option"
import {Versioned} from "@services/shared/utils"

export interface WorkflowTemplateRepository {
  /**
   * Creates a new workflow template.
   * @param data The workflow template to create
   * @returns The created workflow template or validation/creation errors
   */
  createWorkflowTemplate(
    data: WorkflowTemplate
  ): TaskEither<CreateWorkflowTemplateRepoError | WorkflowTemplateValidationError, WorkflowTemplate>

  /**
   * Retrieves a workflow template by its unique identifier.
   * @param templateId The unique ID of the workflow template
   * @returns The versioned workflow template or an error if not found
   */
  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>

  /**
   * Retrieves a workflow template by its name and version.
   * @param templateName The name of the workflow template
   * @param version The version of the workflow template
   * @returns The versioned workflow template or an error if not found
   */
  getWorkflowTemplateByNameAndVersion(
    templateName: string,
    version: string
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>

  /**
   * Finds the most recent non-active workflow template for a given name.
   * Non-active templates are those not in ACTIVE status.
   * @param templateName The name of the workflow template to search for
   * @returns An optional versioned workflow template (None if no non-active templates exist)
   */
  getMostRecentNonActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, Option<Versioned<WorkflowTemplate>>>

  /**
   * Updates an existing workflow template with optimistic concurrency control.
   * @param template The versioned workflow template with updates to apply
   * @returns The updated versioned workflow template or concurrency/validation errors
   */
  updateWorkflowTemplate(
    template: Versioned<WorkflowTemplate>
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>>

  /**
   * Retrieves a paginated list of workflow template summaries.
   * @param request Pagination parameters and requestor context
   * @returns A paginated response containing workflow template summaries
   */
  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse>

  /**
   * Atomically updates an existing workflow template and creates a new one.
   * This operation ensures both actions succeed or fail together.
   * @param data Contains the template to update and the new template to create
   * @returns The newly created workflow template or transaction errors
   */
  atomicUpdateAndCreate(data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }): TaskEither<WorkflowTemplateUpdateError | CreateWorkflowTemplateRepoError, WorkflowTemplate>
}

export interface ListWorkflowTemplatesRequest extends RequestorAwareRequest {
  pagination: {
    page: number
    limit: number
  }
}

export interface ListWorkflowTemplatesResponse {
  templates: ReadonlyArray<WorkflowTemplateSummary>
  pagination: {
    total: number
    page: number
    limit: number
  }
}

export type CreateWorkflowTemplateError = WorkflowTemplateValidationError | CreateWorkflowTemplateRepoError

export interface CreateWorkflowTemplateRequest extends RequestorAwareRequest {
  workflowTemplateData: {
    name: string
    description?: string
    approvalRule: ApprovalRule
    actions?: ReadonlyArray<WorkflowAction>
    defaultExpiresInHours?: number
  }
}

export interface UpdateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  workflowTemplateData: Partial<CreateWorkflowTemplateRequest["workflowTemplateData"]>
  cancelWorkflows?: boolean
}

export interface DeprecateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  cancelWorkflows?: boolean
}

export type CreateWorkflowTemplateRepoError = UnknownError | "workflow_template_already_exists"

export interface CreateWorkflowTemplateRepo {
  workflowTemplate: WorkflowTemplate
}

export const WORKFLOW_TEMPLATE_REPOSITORY_TOKEN = Symbol("WORKFLOW_TEMPLATE_REPOSITORY_TOKEN")

export type WorkflowTemplateGetError = "workflow_template_not_found" | WorkflowTemplateValidationError | UnknownError
export type WorkflowTemplateUpdateError =
  | "workflow_template_not_found"
  | "concurrency_error"
  | "workflow_template_already_exists"
  | UnknownError
  | WorkflowTemplateValidationError

export type WorkflowTemplateDeprecateError =
  | "workflow_template_not_found"
  | "workflow_template_not_active"
  | "workflow_template_not_pending_deprecation"
  | UnknownError
  | WorkflowTemplateValidationError
  | WorkflowTemplateUpdateError
