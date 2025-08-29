import {GetAuthenticatedEntity} from "@app/auth"
import {WorkflowDecoratorSelector} from "@domain"
import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res, Query} from "@nestjs/common"
import {
  CreateWorkflowRequest,
  WorkflowService,
  VoteService,
  CanVoteRequest,
  CastVoteRequest,
  AuthenticatedEntity
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createWorkflowApiToServiceModel,
  generateErrorResponseForCreateWorkflow,
  generateErrorResponseForGetWorkflow,
  generateErrorResponseForListWorkflows,
  mapWorkflowToApi,
  mapWorkflowListToApi,
  mapCanVoteResponseToApi,
  createCastVoteApiToServiceModel,
  generateErrorResponseForCanVote,
  generateErrorResponseForCastVote,
  validateWorkflowCreateRequest,
  validateApiRequest
} from "./workflows.mappers"
import {Workflow as WorkflowApi, CanVoteResponse as CanVoteResponseApi, ListWorkflows200Response} from "@approvio/api"

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
    @Body() request: unknown,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // Wrap service call in lambda to preserve context and pass requestor
    const serviceCreateWorkflow = (req: CreateWorkflowRequest) => this.workflowService.createWorkflow(req)

    const eitherWorkflow = await pipe(
      TE.Do,
      TE.bindW("validatedApiRequest", () => TE.fromEither(validateWorkflowCreateRequest(request))),
      TE.bindW("requestor", () => TE.right(requestor)),
      TE.bindW("serviceRequest", ({validatedApiRequest, requestor}) =>
        TE.fromEither(createWorkflowApiToServiceModel({workflowData: validatedApiRequest, requestor}))
      ),
      TE.chainW(({serviceRequest}) => serviceCreateWorkflow(serviceRequest))
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
  async getWorkflow(@Param("identifier") identifier: string, @Query("include") include?: string): Promise<WorkflowApi> {
    const workflowDecoratorSelector = includeOptionsToWorkflowDecoratorSelector(include)

    const getWorkflowService = (request: string) =>
      this.workflowService.getWorkflowByIdentifier(request, workflowDecoratorSelector)

    const eitherWorkflow = await pipe(
      identifier,
      TE.right,
      TE.chainW(getWorkflowService),
      TE.map(workflow => mapWorkflowToApi(workflow, workflowDecoratorSelector))
    )()

    if (isLeft(eitherWorkflow)) {
      throw generateErrorResponseForGetWorkflow(eitherWorkflow.left, "Failed to get workflow")
    }

    return eitherWorkflow.right
  }

  @Get()
  async listWorkflows(
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query("include") include?: string,
    @Query("include-only-non-terminal-state") includeOnlyNonTerminalState?: string
  ): Promise<ListWorkflows200Response> {
    const pageNum = parseInt(page, 10) || 1
    const limitNum = parseInt(limit, 10) || 20
    const workflowDecoratorSelector = includeOptionsToWorkflowDecoratorSelector(include)
    const includeOnlyNonTerminalStateBool = includeOnlyNonTerminalState === "true"

    const request = {
      pagination: {page: pageNum, limit: limitNum},
      include: workflowDecoratorSelector,
      requestor,
      filters: includeOnlyNonTerminalStateBool ? {includeOnlyNonTerminalState: true} : undefined
    }

    const eitherWorkflows = await pipe(
      request,
      TE.right,
      TE.chainW(req => this.workflowService.listWorkflows(req)),
      TE.map(mapWorkflowListToApi)
    )()

    if (isLeft(eitherWorkflows)) {
      throw generateErrorResponseForListWorkflows(eitherWorkflows.left, "Failed to list workflows")
    }

    return eitherWorkflows.right
  }

  @Get(":workflowId/canVote")
  @HttpCode(HttpStatus.OK)
  async canVote(
    @Param("workflowId") workflowId: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
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
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const serviceCastVote = (req: CastVoteRequest) => this.voteService.castVote(req)

    const eitherVote = await pipe(
      TE.Do,
      TE.bindW("validatedRequest", () => TE.fromEither(validateApiRequest(request))),
      TE.bindW("serviceRequest", ({validatedRequest}) =>
        TE.fromEither(createCastVoteApiToServiceModel({workflowId, request: validatedRequest, requestor}))
      ),
      TE.chainW(({serviceRequest}) => serviceCastVote(serviceRequest))
    )()

    if (isLeft(eitherVote))
      throw generateErrorResponseForCastVote(eitherVote.left, `Failed to cast vote for workflow ${workflowId}`)
  }
}

function includeOptionsToWorkflowDecoratorSelector(include?: string): WorkflowDecoratorSelector | undefined {
  if (!include) return undefined
  const split = include.split(",").map(s => s.trim())

  return {
    workflowTemplate: split.includes("workflow-template")
  }
}
