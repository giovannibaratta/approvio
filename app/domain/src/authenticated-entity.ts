import {User, Agent, Versioned, UnconstrainedBoundRole} from "@domain"

export type AuthenticatedEntity = AuthenticatedUser | AuthenticatedAgent

/**
 * Contextual information regarding the authentication event, specifically for step-up authentication.
 * This includes details like the operation being authorized, the resource involved, and the authentication context reference (ACR).
 *
 * @property jti - The unique identifier of the JWT.
 * @property operation - The specific operation (e.g., 'vote') authorized by this token.
 * @property resource - The resource identifier (e.g., workflow ID) this token is bound to.
 * @property acr - Authentication Context Class Reference, indicating the level of assurance.
 */
export interface StepUpContext {
  jti: string
  operation: string
  resource: string
  acr?: string
}

export type AuthenticatedUser = {
  entityType: "user"
  user: Versioned<User>
  // This field contains IDP-specific authentication context.
  // It is typed as unknown here to decouple the domain from specific Auth implementation details,
  // but it is expected to hold a StepUpContext at runtime for step-up scenarios.
  authContext?: unknown
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

export function getEntityRoles(entity: AuthenticatedEntity): ReadonlyArray<UnconstrainedBoundRole> {
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
