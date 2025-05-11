import {Workflow, WorkflowFactory, WorkflowValidationError} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {WORKFLOW_REPOSITORY_TOKEN, WorkflowGetError, WorkflowRepository} from "./interfaces"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {Versioned} from "@services/shared/utils"
import {isUUIDv4} from "@utils"
import {CreateWorkflowError, CreateWorkflowRepo, CreateWorkflowRequest} from "./interfaces"

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY_TOKEN)
    private readonly workflowRepo: WorkflowRepository
  ) {}

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
      TE.map(workflow => ({workflow, requestor: request.requestor})),
      TE.chainW(persistWorkflow)
    )
  }

  getWorkflowByIdentifier(identifier: string): TaskEither<WorkflowGetError, Versioned<Workflow>> {
    const isUuid = isUUIDv4(identifier)

    // Wrap repository calls in lambdas to preserve 'this'
    const repoGetWorkflow = (value: string) =>
      isUuid ? this.workflowRepo.getWorkflowById(value) : this.workflowRepo.getWorkflowByName(value)

    return pipe(identifier, TE.right, TE.chainW(repoGetWorkflow))
  }
}
