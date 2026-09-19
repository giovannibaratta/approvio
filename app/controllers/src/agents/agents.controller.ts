import {
  AgentRegistrationRequest,
  AgentRegistrationResponse,
  RoleAssignmentRequest,
  RoleRemovalRequest,
  AgentGet200Response,
  validateRoleAssignmentRequest,
  validateRoleRemovalRequest
} from "@approvio/api"
import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  Res
} from "@nestjs/common"
import {
  AgentService,
  RegisterAgentRequest,
  RoleService,
  AssignRolesToAgentRequest,
  RemoveRolesFromAgentRequest
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {
  agentRegistrationApiToServiceModel,
  generateErrorResponseForRegisterAgent,
  generateErrorResponseForAgentRoleAssignment,
  generateErrorResponseForAgentRoleRemoval,
  generateErrorResponseForGetAgent,
  bindRoleScopeToOrganization,
  mapAgentToRegistrationResponse,
  mapAgentToApi
} from "./agents.mappers"
import {AuthenticatedEntity, TenantContext, roleScopeToString} from "@domain"
import {logSuccess} from "@utils"
import {ConfigProvider} from "@external/config"
import {createEntityTag, parseEntityTag} from "../etag"
import {PreconditionFailedException} from "@nestjs/common"
import {generateErrorPayload} from "../error"

export const AGENTS_ENDPOINT_ROOT = "o/:organizationId/agents"

@Controller(AGENTS_ENDPOINT_ROOT)
export class AgentsController {
  private readonly etagSecret: string

  constructor(
    private readonly agentService: AgentService,
    private readonly roleService: RoleService,
    private readonly configProvider: ConfigProvider
  ) {
    this.etagSecret = configProvider.jwtConfig.secret
  }

  @Get(":idOrName")
  @HttpCode(HttpStatus.OK)
  async getAgent(
    @Param("idOrName") idOrName: string,
    @GetTenantContext() context: TenantContext,
    @Res({passthrough: true}) response: Response
  ): Promise<AgentGet200Response> {
    const eitherAgent = await pipe(
      this.agentService.getAgent(context, idOrName),
      logSuccess("Agent retrieved", "AgentsController", agent => ({agentId: agent.id}))
    )()

    if (isLeft(eitherAgent)) throw generateErrorResponseForGetAgent(eitherAgent.left, "Failed to fetch agent details")

    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, eitherAgent.right.id, eitherAgent.right.occ)
    )
    return mapAgentToApi(eitherAgent.right)
  }

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async registerAgent(
    @Body() request: AgentRegistrationRequest,
    @Res({passthrough: true}) response: Response,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() entity: AuthenticatedEntity
  ): Promise<AgentRegistrationResponse> {
    const serviceRegisterAgent = (req: RegisterAgentRequest) => this.agentService.registerAgent(req)

    const eitherAgent = await pipe(
      {agentData: request, requestor: entity, context},
      agentRegistrationApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceRegisterAgent),
      logSuccess("Agent registered", "AgentsController", agent => ({agentName: agent.agentName})),
      TE.orElseFirstW(error => TE.fromIO(() => Logger.error(`Failed to register agent ${request.agentName}: ${error}`)))
    )()

    if (isLeft(eitherAgent)) throw generateErrorResponseForRegisterAgent(eitherAgent.left, "Failed to register agent")

    const agent = eitherAgent.right
    const location = `${response.req.protocol}://${response.req.headers.host}/o/${context.organizationId}/agents/${agent.id}`
    response.setHeader("Location", location)

    return mapAgentToRegistrationResponse(agent)
  }

  @Put(":agentId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRolesToAgent(
    @Param("agentId") agentId: string,
    @Body() request: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // TODO: This should have been node inside the pipe.
    const occVersion = parseEntityTag(this.etagSecret, context.organizationId, agentId, ifMatch)
    if (isLeft(occVersion))
      throw new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current entity tag")
      )

    const mapToServiceModel = (req: RoleAssignmentRequest) => ({
      agentId,
      roles: req.roles.map(role => ({...role, scope: bindRoleScopeToOrganization(role.scope, context.organizationId)})),
      requestor,
      context,
      occVersion: occVersion.right
    })
    const assignRole = (req: AssignRolesToAgentRequest) => this.roleService.assignRolesToAgent(req)

    const eitherResult = await pipe(
      TE.Do,
      TE.bindW("validatedRequest", () => TE.fromEither(validateRoleAssignmentRequest(request))),
      TE.bindW("serviceRequest", ({validatedRequest}) => TE.right(mapToServiceModel(validatedRequest))),
      TE.chainFirstW(({serviceRequest}) => assignRole(serviceRequest)),
      logSuccess("Roles assigned to agent", "AgentsController", ({serviceRequest}) => ({
        agentId,
        roles: serviceRequest.roles.map(role => `${roleScopeToString(role.scope)}:${role.roleName}`)
      }))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForAgentRoleAssignment(eitherResult.left, "Failed to assign roles to agent")
    // TODO: Why are we incrementing the OCC here ? It should be the domain + service. Controller layer should only map the values ?
    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, agentId, occVersion.right + 1n)
    )
  }

  @Delete(":agentId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRolesFromAgent(
    @Param("agentId") agentId: string,
    @Body() request: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const occVersion = parseEntityTag(this.etagSecret, context.organizationId, agentId, ifMatch)
    if (isLeft(occVersion))
      throw new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current entity tag")
      )

    const mapToServiceModel = (req: RoleRemovalRequest) => ({
      agentId,
      roles: req.roles.map(role => ({...role, scope: bindRoleScopeToOrganization(role.scope, context.organizationId)})),
      requestor,
      context,
      occVersion: occVersion.right
    })
    const removeRole = (req: RemoveRolesFromAgentRequest) => this.roleService.removeRolesFromAgent(req)

    const eitherResult = await pipe(
      TE.Do,
      TE.bindW("validatedRequest", () => TE.fromEither(validateRoleRemovalRequest(request))),
      TE.bindW("serviceRequest", ({validatedRequest}) => TE.right(mapToServiceModel(validatedRequest))),
      TE.chainFirstW(({serviceRequest}) => removeRole(serviceRequest)),
      logSuccess("Roles removed from agent", "AgentsController", ({serviceRequest}) => ({
        agentId,
        roles: serviceRequest.roles.map(role => `${roleScopeToString(role.scope)}:${role.roleName}`)
      }))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForAgentRoleRemoval(eitherResult.left, "Failed to remove roles from agent")

    // TODO: Why are we incrementing the OCC here ? It should be the domain + service. Controller layer should only map the values ?
    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, agentId, occVersion.right + 1n)
    )
  }
}
