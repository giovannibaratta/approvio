import {
  DecoratedWorkflow,
  evaluateWorkflowStatus,
  Workflow,
  WorkflowDecoratorSelector,
  WorkflowFactory,
  WorkflowTemplate,
  WorkflowValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {FindVotesError, VOTE_REPOSITORY_TOKEN, VoteRepository} from "../vote/interfaces"
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
  WorkflowUpdateError,
  ListWorkflowsRequest,
  ListWorkflowsResponse
} from "./interfaces"

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository,
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
   * If the workflow is marked for recalculation, its status will be re-evaluated and persisted before being returned.
   * @param identifier The ID (UUID) or name of the workflow.
   * @param includeRef The references to include in the result.
   * @returns A TaskEither with the versioned workflow or an error.
   */
  getWorkflowByIdentifier<T extends WorkflowDecoratorSelector>(
    identifier: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError | FindVotesError | WorkflowUpdateError, DecoratedWorkflow<T>> {
    const isUuid = isUUIDv4(identifier)

    const repoGetWorkflow = (value: string) =>
      isUuid
        ? this.workflowRepo.getWorkflowById(value, {...includeRef, occ: true, workflowTemplate: true})
        : this.workflowRepo.getWorkflowByName(value, {...includeRef, occ: true, workflowTemplate: true})

    return pipe(
      identifier,
      TE.right,
      TE.chainW(repoGetWorkflow),
      TE.chainW(workflow => {
        if (workflow.recalculationRequired) return this.recalculateWorkflowStatus(workflow, includeRef)
        return TE.right(workflow as DecoratedWorkflow<T>)
      })
    )
  }

  /**
   * Lists workflows with pagination.
   * @param request The request containing pagination and include options.
   * @returns A TaskEither with the list of workflows or an error.
   */
  listWorkflows<T extends WorkflowDecoratorSelector>(
    request: ListWorkflowsRequest<T>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponse<T>> {
    return this.workflowRepo.listWorkflows(request)
  }

  private recalculateWorkflowStatus<T extends WorkflowDecoratorSelector>(
    workflow: DecoratedWorkflow<{occ: true; workflowTemplate: true}>,
    includeRef?: T
  ): TaskEither<WorkflowGetError | FindVotesError | WorkflowUpdateError, DecoratedWorkflow<T>> {
    const getVotesTask = () => this.voteRepo.getVotesByWorkflowId(workflow.id)

    return pipe(
      TE.Do,
      TE.bindW("votes", getVotesTask),
      TE.bindW("workflowWithUpdatedStatus", ({votes}) => TE.fromEither(evaluateWorkflowStatus(workflow, votes))),
      TE.chainW(({workflowWithUpdatedStatus}) =>
        this.workflowRepo.updateWorkflowConcurrentSafe(
          workflowWithUpdatedStatus.id,
          workflow.occ,
          {
            updatedAt: new Date(),
            status: workflowWithUpdatedStatus.status,
            recalculationRequired: false
          },
          includeRef
        )
      )
    )
  }
}

const DEFAULT_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
