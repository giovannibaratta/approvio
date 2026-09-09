import {Agent, AgentFactory, AgentWithPrivateKey, TenantContext} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {AGENT_REPOSITORY_TOKEN, AgentRepository, AgentRegistrationError, AgentGetError} from "./interfaces"
import {AuthenticatedEntity} from "@domain"
import {AuthorizationError} from "@services/error"
import {isUUIDv7, logSuccess} from "@utils"

@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_REPOSITORY_TOKEN)
    private readonly agentRepo: AgentRepository
  ) {}

  registerAgent(request: RegisterAgentRequest): TaskEither<AgentRegistrationError, AgentWithPrivateKey> {
    const persistAgent = (agent: AgentWithPrivateKey) => this.agentRepo.persistAgent(request.context, agent)

    const validateAndCreateAgent = (
      req: RegisterAgentRequest
    ): E.Either<AgentRegistrationError | AuthorizationError, AgentWithPrivateKey> => {
      if (
        req.requestor.entityType !== "user" ||
        req.requestor.user.organizationId !== req.context.organizationId
      )
        return E.left("requestor_not_authorized")

      return AgentFactory.create({
        organizationId: req.context.organizationId,
        agentName: req.agentName
      })
    }

    return pipe(
      request,
      validateAndCreateAgent,
      TE.fromEither,
      TE.chainFirstW(persistAgent),
      logSuccess("Agent registered", "AgentService", agent => ({agentName: agent.agentName}))
    )
  }

  getAgent(context: TenantContext, idOrName: string): TaskEither<AgentGetError, Agent> {
    const getAgentResult = isUUIDv7(idOrName) ? this.getAgentById(context, idOrName) : this.getAgentByName(context, idOrName)
    return pipe(
      getAgentResult,
      logSuccess("Agent retrieved", "AgentService", agent => ({agentId: agent.id}))
    )
  }

  getAgentByName(context: TenantContext, agentName: string): TaskEither<AgentGetError, Agent> {
    return this.agentRepo.getAgentByName(context, agentName)
  }

  getAgentById(context: TenantContext, agentId: string): TaskEither<AgentGetError, Agent> {
    return this.agentRepo.getAgentById(context, agentId)
  }
}

export interface RegisterAgentRequest {
  readonly agentName: string
  readonly requestor: AuthenticatedEntity
  readonly context: TenantContext
}
