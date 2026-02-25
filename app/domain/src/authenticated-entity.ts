import {User, Agent, Versioned, UnconstrainedBoundRole} from "@domain"

export type AuthenticatedEntity = AuthenticatedUser | AuthenticatedAgent

export type StepUpOperation = "vote" | "admin_action"

const ALLOWED_STEP_UP_OPERATIONS = ["vote", "admin_action"]

export function isStepUpOperation(operation: unknown): operation is StepUpOperation {
  return typeof operation === "string" && ALLOWED_STEP_UP_OPERATIONS.includes(operation)
}

/**
 * Contextual information regarding the authentication event, specifically for step-up authentication.
 * This includes details like the operation being authorized and the resource involved.
 *
 * @property jti - The unique identifier of the JWT.
 * @property operation - The specific operation (e.g., 'vote') authorized by this token.
 * @property resource - The resource identifier (e.g., workflow ID) this token is bound to.
 */
export interface StepUpContext {
  jti: string
  operation: StepUpOperation
  resource?: string
}

export type AuthenticatedUser = {
  entityType: "user"
  user: Versioned<User>
  authContext?: StepUpContext
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
