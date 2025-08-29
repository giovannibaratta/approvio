import {AgentRegistrationRequest, AgentRegistrationResponse} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {Body, Controller, HttpCode, HttpStatus, Post, Res} from "@nestjs/common"
import {AgentService, AuthenticatedEntity, RegisterAgentRequest} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  agentRegistrationApiToServiceModel,
  generateErrorResponseForRegisterAgent,
  mapAgentToRegistrationResponse
} from "./agents.mappers"

export const AGENTS_ENDPOINT_ROOT = "agents"

@Controller(AGENTS_ENDPOINT_ROOT)
export class AgentsController {
  constructor(private readonly agentService: AgentService) {}

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
}
