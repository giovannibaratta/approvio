import {Agent, AgentFactory, AgentWithPrivateKey} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {AGENT_REPOSITORY_TOKEN, AgentRepository, AgentRegistrationError, AgentGetError} from "./interfaces"
import {AuthenticatedEntity} from "@domain"
import {AuthorizationError} from "@services/error"
import {isUUIDv4, logSuccess} from "@utils"

@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_REPOSITORY_TOKEN)
    private readonly agentRepo: AgentRepository
  ) {}

  registerAgent(request: RegisterAgentRequest): TaskEither<AgentRegistrationError, AgentWithPrivateKey> {
    const persistAgent = (agent: AgentWithPrivateKey) => this.agentRepo.persistAgent(agent)

    const validateAndCreateAgent = (
      req: RegisterAgentRequest
    ): E.Either<AgentRegistrationError | AuthorizationError, AgentWithPrivateKey> => {
      if (req.requestor.entityType !== "user") return E.left("requestor_not_authorized")

      return AgentFactory.create({
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

  getAgent(idOrName: string): TaskEither<AgentGetError, Agent> {
    const getAgentResult = isUUIDv4(idOrName) ? this.getAgentById(idOrName) : this.getAgentByName(idOrName)
    return pipe(
      getAgentResult,
      logSuccess("Agent retrieved", "AgentService", agent => ({agentId: agent.id}))
    )
  }

  getAgentByName(agentName: string): TaskEither<AgentGetError, Agent> {
    return this.agentRepo.getAgentByName(agentName)
  }

  getAgentById(agentId: string): TaskEither<AgentGetError, Agent> {
    return this.agentRepo.getAgentById(agentId)
  }
}

export interface RegisterAgentRequest {
  readonly agentName: string
  readonly requestor: AuthenticatedEntity
}
