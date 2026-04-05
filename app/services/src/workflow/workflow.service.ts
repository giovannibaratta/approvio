import {
  DecoratedWorkflow,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowFactory,
  WorkflowTemplate,
  WorkflowValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  WorkflowTemplateGetError,
  WorkflowTemplateRepository
} from "../workflow-template/interfaces"
import {isUUIDv4} from "@utils"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {
  CreateWorkflowError,
  CreateWorkflowRepo,
  CreateWorkflowRequest,
  WORKFLOW_REPOSITORY_TOKEN,
  WorkflowGetError,
  WorkflowRepository,
  ListWorkflowsRequest,
  ListWorkflowsRequestRepo,
  ListWorkflowsResponse
} from "./interfaces"

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(WORKFLOW_TEMPLATE_REPOSITORY_TOKEN)
    private readonly workflowTemplateRepo: WorkflowTemplateRepository
  ) {}

  /**
   * Creates a new workflow.
   * @param request The request containing the workflow data and the requestor.
   * @returns A TaskEither with the created workflow or an error.
   */
  createWorkflow(request: CreateWorkflowRequest): TaskEither<CreateWorkflowError | WorkflowTemplateGetError, Workflow> {
    // Wrap repo call in a lambda to preserve `this` context
    const persistWorkflow = (data: CreateWorkflowRepo) => this.workflowRepo.createWorkflow(data)

    const getWorkflowTemplate = (
      request: CreateWorkflowRequest
    ): TaskEither<WorkflowTemplateGetError, WorkflowTemplate> => {
      return this.workflowTemplateRepo.getWorkflowTemplateById(request.workflowData.workflowTemplateId)
    }

    const validateAndCreateWorkflow = (
      template: WorkflowTemplate,
      request: CreateWorkflowRequest
    ): TaskEither<WorkflowValidationError, Workflow> => {
      const {workflowData} = request

      const expiresAt = template.defaultExpiresInHours
        ? new Date(Date.now() + template.defaultExpiresInHours * 60 * 60 * 1000)
        : new Date(Date.now() + DEFAULT_EXPIRES_IN_MS)

      const workflow = WorkflowFactory.newWorkflow({...workflowData, expiresAt})
      return TE.fromEither(workflow)
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("template", ({request}) => getWorkflowTemplate(request)),
      TE.bindW("workflow", ({request, template}) => validateAndCreateWorkflow(template, request)),
      TE.chainW(({workflow}) => persistWorkflow({workflow}))
    )
  }

  /**
   * Gets a workflow by its ID or name.
   * Note: If recalculationRequired is true, the status may be stale (recalculation in progress).
   * @param identifier The ID (UUID) or name of the workflow.
   * @param includeRef The references to include in the result.
   * @returns A TaskEither with the workflow or an error.
   */
  getWorkflowByIdentifier<T extends WorkflowDecoratorSelector>(
    identifier: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>> {
    const isUuid = isUUIDv4(identifier)

    const repoGetWorkflow = (value: string) =>
      isUuid
        ? this.workflowRepo.getWorkflowById(value, includeRef)
        : this.workflowRepo.getWorkflowByName(value, includeRef)

    return pipe(identifier, TE.right, TE.chainW(repoGetWorkflow))
  }

  /**
   * Lists workflows with pagination.
   * @param request The request containing pagination and include options.
   * @returns A TaskEither with the list of workflows or an error.
   */
  listWorkflows<T extends WorkflowDecoratorSelector>(
    request: ListWorkflowsRequest<T>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponse<T>> {
    const filters = request.filters
      ? {
          includeOnlyNonTerminalState: request.filters.includeOnlyNonTerminalState,
          workflowTemplateId:
            request.filters.workflowTemplateIdentifier && isUUIDv4(request.filters.workflowTemplateIdentifier)
              ? request.filters.workflowTemplateIdentifier
              : undefined,
          workflowTemplateName:
            request.filters.workflowTemplateIdentifier && !isUUIDv4(request.filters.workflowTemplateIdentifier)
              ? request.filters.workflowTemplateIdentifier
              : undefined
        }
      : undefined

    const repoRequest: ListWorkflowsRequestRepo<T> = {
      ...request,
      filters
    }

    return this.workflowRepo.listWorkflows(repoRequest)
  }
}

const DEFAULT_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
