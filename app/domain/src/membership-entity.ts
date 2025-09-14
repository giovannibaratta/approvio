import {User, Agent, EntityReference} from "@domain"

export type MembershipEntity = UserEntity | AgentEntity

type UserEntity = {
  type: "user"
  user: User
}

type AgentEntity = {
  type: "agent"
  agent: Agent
}

export function createUserMembershipEntity(user: User): MembershipEntity {
  return {type: "user", user}
}

export function createAgentMembershipEntity(agent: Agent): MembershipEntity {
  return {type: "agent", agent}
}

export function getMembershipEntityId(entity: MembershipEntity): string {
  switch (entity.type) {
    case "user":
      return entity.user.id
    case "agent":
      return entity.agent.id
  }
}

export function getMembershipEntityType(entity: MembershipEntity): MembershipEntity["type"] {
  return entity.type
}

/**
 * Returns a normalized unique identifier for the entity across all entity types.
 * Format: "type:id" where type is the entity type and id is the actual entity id.
 * This ensures uniqueness even if users and agents have the same UUID.
 *
 * @param entity The membership entity (user or agent)
 * @returns A unique string identifier in the format "user:uuid" or "agent:uuid"
 */
export function getNormalizedId(entity: MembershipEntity | EntityReference): string {
  if ("entityId" in entity) return `${entity.entityType}:${entity.entityId}`
  return `${entity.type}:${getMembershipEntityId(entity)}`
}
