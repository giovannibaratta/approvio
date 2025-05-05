import {WorkflowCreate} from "@api"
import {GetAuthenticatedUser} from "@app/auth"
import {User} from "@domain"
import {Body, Controller, HttpCode, HttpStatus, Post, Res} from "@nestjs/common"
import {CreateWorkflowRequest, WorkflowService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {createWorkflowApiToServiceModel, generateErrorResponseForCreateWorkflow} from "./workflows.mappers"

export const WORKFLOWS_ENDPOINT_ROOT = "workflows"

@Controller(WORKFLOWS_ENDPOINT_ROOT)
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWorkflow(
    @Body() request: WorkflowCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedUser() requestor: User
  ): Promise<void> {
    // Wrap service call in lambda to preserve context and pass requestor
    const serviceCreateWorkflow = (req: CreateWorkflowRequest) => this.workflowService.createWorkflow(req)

    const eitherWorkflow = await pipe(
      {workflowData: request, requestor},
      createWorkflowApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateWorkflow)
    )()

    if (isLeft(eitherWorkflow)) {
      throw generateErrorResponseForCreateWorkflow(eitherWorkflow.left, "Failed to create workflow")
    }

    const workflow = eitherWorkflow.right
    // Set Location header
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${workflow.id}`
    response.setHeader("Location", location)
  }
}
