import {Workflow, WorkflowFactory, WorkflowValidationError} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {FindVotesError, VOTE_REPOSITORY_TOKEN, VoteRepository} from "../vote/interfaces"
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
  ListWorkflowsResponse,
  WorkflowDecoratorSelector,
  DecoratedWorkflow
} from "./interfaces"

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository,
    @Inject(VOTE_REPOSITORY_TOKEN)
    private readonly voteRepo: VoteRepository
  ) {}

  /**
   * Creates a new workflow.
   * @param request The request containing the workflow data and the requestor.
   * @returns A TaskEither with the created workflow or an error.
   */
  createWorkflow(request: CreateWorkflowRequest): TaskEither<CreateWorkflowError, Workflow> {
    // Wrap repo call in a lambda to preserve `this` context
    const persistWorkflow = (data: CreateWorkflowRepo) => this.workflowRepo.createWorkflow(data)

    const validateRequest = (request: CreateWorkflowRequest): TaskEither<WorkflowValidationError, Workflow> => {
      const {workflowData} = request
      const workflow = WorkflowFactory.newWorkflow(workflowData)
      return TE.fromEither(workflow)
    }

    return pipe(
      request,
      validateRequest,
      TE.map(workflow => ({workflow})),
      TE.chainW(persistWorkflow)
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
        ? this.workflowRepo.getWorkflowById(value, {...includeRef, occ: true})
        : this.workflowRepo.getWorkflowByName(value, {...includeRef, occ: true})

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
    workflow: DecoratedWorkflow<{occ: true}>,
    includeRef?: T
  ): TaskEither<WorkflowGetError | FindVotesError | WorkflowUpdateError, DecoratedWorkflow<T>> {
    const getVotesTask = () => this.voteRepo.getVotesByWorkflowId(workflow.id)

    return pipe(
      TE.Do,
      TE.bindW("votes", getVotesTask),
      TE.bindW("workflowWithUpdatedStatus", ({votes}) => TE.fromEither(workflow.evaluateStatus(votes))),
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
