import {
  AgentRegistrationRequest,
  AgentRegistrationResponse,
  RoleAssignmentRequest,
  RoleRemovalRequest
} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, Put, Res} from "@nestjs/common"
import {
  AgentService,
  RegisterAgentRequest,
  RoleService,
  AssignRolesToAgentRequest,
  RemoveRolesFromAgentRequest
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {
  agentRegistrationApiToServiceModel,
  generateErrorResponseForRegisterAgent,
  generateErrorResponseForAgentRoleAssignment,
  generateErrorResponseForAgentRoleRemoval,
  mapAgentToRegistrationResponse
} from "./agents.mappers"
import {validateRoleAssignmentRequest, validateRoleRemovalRequest} from "../shared/mappers"
import {AuthenticatedEntity} from "@domain"

export const AGENTS_ENDPOINT_ROOT = "agents"

@Controller(AGENTS_ENDPOINT_ROOT)
export class AgentsController {
  constructor(
    private readonly agentService: AgentService,
    private readonly roleService: RoleService
  ) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async registerAgent(
    @Body() request: AgentRegistrationRequest,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() entity: AuthenticatedEntity
  ): Promise<AgentRegistrationResponse> {
    const serviceRegisterAgent = (req: RegisterAgentRequest) => this.agentService.registerAgent(req)

    const eitherAgent = await pipe(
      {agentData: request, requestor: entity},
      agentRegistrationApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceRegisterAgent)
    )()

    if (isLeft(eitherAgent)) throw generateErrorResponseForRegisterAgent(eitherAgent.left, "Failed to register agent")

    const agent = eitherAgent.right
    const location = `${response.req.protocol}://${response.req.headers.host}/agents/${agent.id}`
    response.setHeader("Location", location)

    return mapAgentToRegistrationResponse(agent)
  }

  @Put(":agentId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRolesToAgent(
    @Param("agentId") agentId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const mapToServiceModel = (req: RoleAssignmentRequest) => ({
      agentId,
      roles: req.roles,
      requestor
    })
    const assignTole = (req: AssignRolesToAgentRequest) => this.roleService.assignRolesToAgent(req)

    const eitherResult = await pipe(
      request,
      E.right,
      E.chainW(validateRoleAssignmentRequest),
      E.map(mapToServiceModel),
      TE.fromEither,
      TE.chainW(assignTole)
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForAgentRoleAssignment(eitherResult.left, "Failed to assign roles to agent")
  }

  @Delete(":agentId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRolesFromAgent(
    @Param("agentId") agentId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const mapToServiceModel = (req: RoleRemovalRequest) => ({
      agentId,
      roles: req.roles,
      requestor
    })
    const removeRole = (req: RemoveRolesFromAgentRequest) => this.roleService.removeRolesFromAgent(req)

    const eitherResult = await pipe(
      request,
      E.right,
      E.chainW(validateRoleRemovalRequest),
      E.map(mapToServiceModel),
      TE.fromEither,
      TE.chainW(removeRole)
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForAgentRoleRemoval(eitherResult.left, "Failed to remove roles from agent")
  }
}
