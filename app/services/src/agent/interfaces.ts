import {Agent, AgentValidationError, AgentCreationError} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type AgentKeyDecodeError = "agent_key_decode_error"

export type AgentCreateError = "agent_name_already_exists" | AgentKeyDecodeError | AgentValidationError | UnknownError

export type AgentGetError = "agent_not_found" | AgentKeyDecodeError | AgentValidationError | UnknownError

export type AgentRegistrationError = AgentCreationError | AgentCreateError | AuthorizationError

export const AGENT_REPOSITORY_TOKEN = "AGENT_REPOSITORY_TOKEN"

export interface AgentRepository {
  persistAgent(agent: Agent): TaskEither<AgentCreateError, Agent>
  getAgentById(agentId: string): TaskEither<AgentGetError, Agent>
  getAgentByName(agentName: string): TaskEither<AgentGetError, Agent>
}
