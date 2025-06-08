import {GetAuthenticatedUser} from "@app/auth"
import {User} from "@domain"
import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res} from "@nestjs/common"
import {CreateWorkflowRequest, WorkflowService, VoteService, CanVoteRequest, CastVoteRequest} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createWorkflowApiToServiceModel,
  generateErrorResponseForCreateWorkflow,
  generateErrorResponseForGetWorkflow,
  mapWorkflowToApi,
  mapCanVoteResponseToApi,
  createCastVoteApiToServiceModel,
  generateErrorResponseForCanVote,
  generateErrorResponseForCastVote
} from "./workflows.mappers"
import {
  Workflow as WorkflowApi,
  CanVoteResponse as CanVoteResponseApi,
  WorkflowVoteRequest as WorkflowVoteRequestApi,
  WorkflowCreate
} from "@approvio/api"

export const WORKFLOWS_ENDPOINT_ROOT = "workflows"

@Controller(WORKFLOWS_ENDPOINT_ROOT)
export class WorkflowsController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly voteService: VoteService
  ) {}

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

  @Get(":identifier")
  async getWorkflow(@Param("identifier") identifier: string): Promise<WorkflowApi> {
    const getWorkflowService = (request: string) => this.workflowService.getWorkflowByIdentifier(request)

    const eitherWorkflow = await pipe(identifier, TE.right, TE.chainW(getWorkflowService), TE.map(mapWorkflowToApi))()

    if (isLeft(eitherWorkflow)) {
      throw generateErrorResponseForGetWorkflow(eitherWorkflow.left, "Failed to get workflow")
    }

    return eitherWorkflow.right
  }

  @Get(":workflowId/canVote")
  @HttpCode(HttpStatus.OK)
  async canVote(
    @Param("workflowId") workflowId: string,
    @GetAuthenticatedUser() requestor: User
  ): Promise<CanVoteResponseApi> {
    const serviceCanVote = (request: CanVoteRequest) => this.voteService.canVote(request)

    const eitherCanVoteResponse = await pipe(
      {workflowId, requestor},
      TE.right,
      TE.chainW(serviceCanVote),
      TE.map(mapCanVoteResponseToApi)
    )()

    if (isLeft(eitherCanVoteResponse)) {
      throw generateErrorResponseForCanVote(
        eitherCanVoteResponse.left,
        `Failed to process canVote request for workflow ${workflowId}`
      )
    }
    return eitherCanVoteResponse.right
  }

  @Post(":workflowId/vote")
  @HttpCode(HttpStatus.ACCEPTED)
  async castVote(
    @Param("workflowId") workflowId: string,
    @Body() request: WorkflowVoteRequestApi,
    @GetAuthenticatedUser() requestor: User
  ): Promise<void> {
    const serviceCastVote = (req: CastVoteRequest) => this.voteService.castVote(req)

    const eitherVote = await pipe(
      {workflowId, request, requestor},
      createCastVoteApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCastVote)
    )()

    if (isLeft(eitherVote))
      throw generateErrorResponseForCastVote(eitherVote.left, `Failed to cast vote for workflow ${workflowId}`)
  }
}
