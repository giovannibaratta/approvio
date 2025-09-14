import {User, Agent, Versioned, BoundRole} from "@domain"

export type AuthenticatedEntity = AuthenticatedUser | AuthenticatedAgent

export type AuthenticatedUser = {
  entityType: "user"
  user: Versioned<User>
}

export type AuthenticatedAgent = {
  entityType: "agent"
  agent: Agent
}

export interface EntityReference {
  entityId: string
  entityType: "user" | "agent"
}

export function getEntityId(entity: AuthenticatedEntity): string {
  switch (entity.entityType) {
    case "user":
      return entity.user.id
    case "agent":
      return entity.agent.id
  }
}

export function getEntityType(entity: AuthenticatedEntity): EntityReference["entityType"] {
  return entity.entityType
}

export function getEntityRoles(entity: AuthenticatedEntity): ReadonlyArray<BoundRole<string>> {
  switch (entity.entityType) {
    case "user":
      return entity.user.roles
    case "agent":
      return entity.agent.roles
  }
}

export function createEntityReference(entity: AuthenticatedEntity): EntityReference {
  return {
    entityId: getEntityId(entity),
    entityType: getEntityType(entity)
  }
}

/**
 * Returns a normalized unique identifier for the entity across all entity types.
 * Format: "type:id" where type is the entity type and id is the actual entity id.
 * This ensures uniqueness even if users and agents have the same UUID.
 */
export function getNormalizedEntityId(entity: AuthenticatedEntity | EntityReference): string {
  if ("entityId" in entity) {
    return `${entity.entityType}:${entity.entityId}`
  }
  return `${entity.entityType}:${getEntityId(entity)}`
}
