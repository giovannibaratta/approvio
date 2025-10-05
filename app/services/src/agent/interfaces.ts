import {Agent, AgentValidationError, AgentCreationError, DecoratedAgent} from "@domain"
import {AuthorizationError, ConcurrentModificationError, UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type AgentKeyDecodeError = "agent_key_decode_error"

export type AgentCreateError = "agent_name_already_exists" | AgentKeyDecodeError | AgentValidationError | UnknownError

export type AgentGetError = "agent_not_found" | AgentKeyDecodeError | AgentValidationError | UnknownError
export type AgentUpdateError = AgentGetError | ConcurrentModificationError

export type AgentRegistrationError = AgentCreationError | AgentCreateError | AuthorizationError

export const AGENT_REPOSITORY_TOKEN = "AGENT_REPOSITORY_TOKEN"

export interface AgentRepository {
  persistAgent(agent: Agent): TaskEither<AgentCreateError, Agent>
  getAgentById(agentId: string): TaskEither<AgentGetError, DecoratedAgent<{occ: true}>>
  getAgentByName(agentName: string): TaskEither<AgentGetError, Agent>
  updateAgent(agent: DecoratedAgent<{occ: true}>): TaskEither<AgentUpdateError, Agent>
}
