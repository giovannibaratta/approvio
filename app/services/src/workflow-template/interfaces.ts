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
import {Versioned} from "@services/shared/utils"

export interface WorkflowTemplateRepository {
  createWorkflowTemplate(
    data: WorkflowTemplate
  ): TaskEither<CreateWorkflowTemplateRepoError | WorkflowTemplateValidationError, WorkflowTemplate>
  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>
  getWorkflowTemplateByName(templateName: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>
  updateWorkflowTemplate(
    templateId: string,
    data: WorkflowTemplateUpdateDataRepo,
    occCheck?: bigint
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>>
  deleteWorkflowTemplate(templateId: string): TaskEither<WorkflowTemplateDeleteError, void>
  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequest
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse>
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
  templateId: string
  workflowTemplateData: Partial<CreateWorkflowTemplateRequest["workflowTemplateData"]>
  occCheck?: bigint
}

export type WorkflowTemplateUpdateDataRepo = Partial<
  Pick<WorkflowTemplate, "name" | "description" | "approvalRule" | "actions" | "defaultExpiresInHours" | "updatedAt">
>

export type CreateWorkflowTemplateRepoError = UnknownError | "workflow_template_already_exists"

export interface CreateWorkflowTemplateRepo {
  workflowTemplate: WorkflowTemplate
}

export const WORKFLOW_TEMPLATE_REPOSITORY_TOKEN = Symbol("WORKFLOW_TEMPLATE_REPOSITORY_TOKEN")

export type WorkflowTemplateGetError = "workflow_template_not_found" | WorkflowTemplateValidationError | UnknownError
export type WorkflowTemplateUpdateError =
  | "workflow_template_not_found"
  | "concurrency_error"
  | UnknownError
  | WorkflowTemplateValidationError
export type WorkflowTemplateDeleteError = "workflow_template_not_found" | UnknownError
