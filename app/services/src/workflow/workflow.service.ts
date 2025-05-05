import {Workflow, WorkflowFactory, WorkflowValidationError} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  CreateWorkflowError,
  CreateWorkflowRepo,
  CreateWorkflowRequest,
  WORKFLOW_REPOSITORY_TOKEN,
  WorkflowRepository
} from "./interfaces"

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
}
