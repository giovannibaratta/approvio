import {Agent, AgentValidationError, AgentCreationError, BoundaryError, DecoratedAgent, TenantContext} from "@domain"
import {AuthorizationError, ConcurrentModificationError, UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type AgentKeyDecodeError = "agent_key_decode_error"

export type AgentCreateError =
  BoundaryError | "agent_name_already_exists" | AgentKeyDecodeError | AgentValidationError | UnknownError

export type AgentGetError =
  BoundaryError | "agent_not_found" | AgentKeyDecodeError | AgentValidationError | UnknownError
export type AgentUpdateError = AgentGetError | ConcurrentModificationError

export type AgentRegistrationError = AgentCreationError | AgentCreateError | AuthorizationError

export const AGENT_REPOSITORY_TOKEN = "AGENT_REPOSITORY_TOKEN"

export interface AgentRepository {
  persistAgent(context: TenantContext, agent: Agent): TaskEither<AgentCreateError, Agent>
  getAgentById(context: TenantContext, agentId: string): TaskEither<AgentGetError, DecoratedAgent<{occ: true}>>
  getAgentByName(context: TenantContext, agentName: string): TaskEither<AgentGetError, Agent>
  updateAgent(context: TenantContext, agent: DecoratedAgent<{occ: true}>): TaskEither<AgentUpdateError, Agent>
}
