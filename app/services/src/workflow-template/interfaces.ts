import {
  WorkflowTemplate,
  WorkflowTemplateValidationError,
  ApprovalRule,
  WorkflowTemplateSummary,
  WorkflowTemplateStatus,
  BoundaryError,
  TenantContext
} from "@domain"
import {EncryptionError, UnknownError} from "@services/error"
import {RequestorAwareRequest} from "@services/shared/types"
import {TaskEither} from "fp-ts/TaskEither"
import {Option} from "fp-ts/Option"
import {Versioned} from "@domain"
import {SortBy, SortDirection} from "@approvio/api"
import {TransactionError} from "../transaction/interfaces"

/** A database-only write prepared before opening the caller's retryable transaction. */
export type DeferredWorkflowTemplateWrite<Error extends string> = () => TaskEither<Error, Versioned<WorkflowTemplate>>

/**
 * A fetched snapshot resolved outside the transaction; successful resolution is cached per object.
 * Callers share the resolved reference and must treat it as immutable. OCC remains the fetched version.
 */
export interface DeferredWorkflowTemplate<Result> {
  readonly resolve: TaskEither<EncryptionError | WorkflowTemplateValidationError, Result>
}

export interface WorkflowTemplateRepository {
  /**
   * Prepares a new workflow template for persistence outside the caller transaction.
   * Execute the returned database-only write inside the quota-checked tenant transaction.
   * @param data The workflow template to create
   * @returns A database-only create execution, or encryption/validation errors
   */
  createDeferredCreateExecution(
    context: TenantContext,
    data: WorkflowTemplate
  ): TaskEither<
    WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateCreateExecutionError | WorkflowTemplateValidationError>
  >
  /** Reads validated template metadata without fetching or decrypting actions. */
  getWorkflowTemplateSummaryById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateSummaryGetError, WorkflowTemplateSummary>
  getParentSpace(context: TenantContext, templateId: string): TaskEither<WorkflowTemplateGetParentSpaceError, string>

  /**
   * Loads a tenant-scoped snapshot by ID in the caller transaction.
   * Call resolve after the transaction to decrypt and validate the fetched snapshot.
   * @param templateId The unique ID of the workflow template
   * @returns A deferred snapshot, or an error if not found
   */
  getWorkflowTemplateById(
    context: TenantContext,
    templateId: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>>

  /**
   * Loads a tenant-scoped name/version snapshot. Resolve it after the caller transaction.
   * @param templateName The name of the workflow template
   * @param version The version of the workflow template
   * @returns A deferred snapshot, or an error if not found
   */
  getWorkflowTemplateByNameAndVersion(
    context: TenantContext,
    templateName: string,
    version: number
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>>

  /**
   * Loads the active tenant-scoped snapshot. Resolve it after the caller transaction.
   * @param templateName The name of the workflow template
   * @returns A deferred snapshot, or an error if not found
   */
  getActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetActiveError, DeferredWorkflowTemplate<Versioned<WorkflowTemplate>>>

  /**
   * Loads the most recent non-active snapshot. Resolve the optional result after the caller transaction.
   * Non-active templates are those not in ACTIVE status.
   * @param templateName The name of the workflow template to search for
   * @returns A deferred optional snapshot (None if no non-active templates exist)
   */
  getMostRecentNonActiveWorkflowTemplateByName(
    context: TenantContext,
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, DeferredWorkflowTemplate<Option<Versioned<WorkflowTemplate>>>>

  /**
   * Prepares an update outside the caller transaction. The returned write checks OCC
   * when executed in the caller transaction; preparation does not reserve a version.
   * @param template The versioned workflow template with updates to apply
   * @returns A database-only update execution; OCC is checked when it runs
   */
  createDeferredUpdateExecution(
    context: TenantContext,
    template: Versioned<WorkflowTemplate>
  ): TaskEither<
    WorkflowTemplateUpdateExecutionError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateUpdateExecutionError>
  >

  /**
   * Retrieves a paginated list of workflow template summaries.
   * @param request Pagination parameters and requestor context
   * @returns A paginated response containing workflow template summaries
   */
  listWorkflowTemplates(
    context: TenantContext,
    request: ListWorkflowTemplatesRequestRepo
  ): TaskEither<BoundaryError | WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse>

  /**
   * Prepares both revisions outside the caller transaction. Execute the returned write
   * inside one tenant transaction to update and create atomically.
   * This operation ensures both actions succeed or fail together.
   * @param data Contains the template to update and the new template to create
   * @returns A database-only execution that updates and creates both revisions atomically
   */
  createDeferredUpdateAndCreateExecution(
    context: TenantContext,
    data: {
      existingTemplate: Versioned<WorkflowTemplate>
      newTemplate: WorkflowTemplate
    }
  ): TaskEither<
    WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError,
    DeferredWorkflowTemplateWrite<WorkflowTemplateUpdateExecutionError | WorkflowTemplateCreateExecutionError>
  >

  /**
   * Retrieves space mappings for a batch of workflow template IDs.
   * @param templateNames Array of workflow template names to look up
   * @returns A map of templateName to spaceId, or an error if any template is not found or missing spaceId
   */
  getWorkflowTemplatesParentsByNames(
    context: TenantContext,
    templateNames: ReadonlyArray<string>
  ): TaskEither<BoundaryError | "workflow_template_not_found", ReadonlyMap<string, string>>

  /**
   * Counts the number of unique workflow templates in a space, revision of a template are not counted as separate templates.
   * @param spaceId The ID of the space to count unique workflow templates in
   * @returns The number of unique workflow templates in the space or an error
   */
  countUniqueWorkflowTemplatesBySpaceId(
    context: TenantContext,
    spaceId: string
  ): TaskEither<UnknownError | BoundaryError, number>
}

export interface Sort {
  readonly field: SortBy
  readonly direction: SortDirection
}

interface ListWorkflowTemplateRequestNoFilters {
  search?: string
  searchMode?: "CONTAINS" | "EXACT"
  pagination: {
    page: number
    limit: number
  }
  sort?: readonly Sort[]
}

export interface ListWorkflowTemplatesRequest extends RequestorAwareRequest, ListWorkflowTemplateRequestNoFilters {
  filters?: {
    spaceIdentifier?: string
    status?: readonly [WorkflowTemplateStatus, ...WorkflowTemplateStatus[]]
  }
}

export interface ListWorkflowTemplatesRequestRepo extends ListWorkflowTemplateRequestNoFilters {
  filters?: {
    spaceId?: string
    spaceName?: string
    status?: readonly [WorkflowTemplateStatus, ...WorkflowTemplateStatus[]]
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

export type CreateWorkflowTemplateError =
  | WorkflowTemplateValidationError
  | WorkflowTemplateCreateExecutionError
  | TransactionError
  | "quota_exceeded"
  | "quota_check_error"

export interface CreateWorkflowTemplateRequest extends RequestorAwareRequest {
  workflowTemplateData: {
    name: string
    description?: string
    approvalRule: ApprovalRule
    actions?: ReadonlyArray<unknown>
    defaultExpiresInHours?: number
    spaceId: string
  }
}

export interface UpdateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  /** The value is used to check for concurrency control, not as a value to be updated */
  occVersion: bigint
  workflowTemplateData: Partial<CreateWorkflowTemplateRequest["workflowTemplateData"]>
  cancelWorkflows?: boolean
}

export interface DeprecateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  cancelWorkflows?: boolean
}

export type WorkflowTemplateCreateExecutionError =
  | BoundaryError
  | UnknownError
  | "workflow_template_already_exists"
  | "workflow_template_approval_group_not_found"
  | EncryptionError

export interface CreateWorkflowTemplateRepo {
  workflowTemplate: WorkflowTemplate
}

export const WORKFLOW_TEMPLATE_REPOSITORY_TOKEN = Symbol("WORKFLOW_TEMPLATE_REPOSITORY_TOKEN")

export type WorkflowTemplateGetActiveError =
  | BoundaryError
  | TransactionError
  | "active_workflow_template_not_found"
  | WorkflowTemplateValidationError
  | EncryptionError
  | UnknownError

export type WorkflowTemplateGetParentSpaceError = BoundaryError | "workflow_template_not_found" | UnknownError

export type WorkflowTemplateSummaryGetError = Exclude<WorkflowTemplateGetError, EncryptionError>

export type WorkflowTemplateGetError =
  | BoundaryError
  | TransactionError
  | "workflow_template_not_found"
  | WorkflowTemplateValidationError
  | EncryptionError
  | UnknownError

export type WorkflowTemplateUpdateExecutionError =
  | BoundaryError
  | "concurrency_error"
  | "workflow_template_already_exists"
  | UnknownError
  | WorkflowTemplateValidationError
  | EncryptionError

export type WorkflowTemplateDeprecateError =
  | "workflow_template_not_active"
  | "workflow_template_not_pending_deprecation"
  | UnknownError
  | WorkflowTemplateValidationError
  | WorkflowTemplateUpdateExecutionError
