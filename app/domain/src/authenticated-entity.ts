import {OrganizationId} from "./shared"
import {Account, User, Agent, UnconstrainedBoundRole} from "@domain"
import {hasOwnProperty, isObject} from "@utils"

export type AuthenticatedEntity = AuthenticatedUser | AuthenticatedAgent

/**
 * Platform sessions represent the authenticated account/browser session before
 * organization selection. They may perform global account and organization-
 * selection operations, but are not tenant principals and cannot access
 * organization-scoped data directly.
 */
export type AuthenticatedPlatformSession = {
  entityType: "platform"
  account: Account
  sessionId: string
  providerId: string
  sessionContextVersion: bigint
}

/** Principals that may read or switch their own browser session context. */
export type AuthenticatedBrowserSession = AuthenticatedPlatformSession | AuthenticatedUser

export type StepUpOperation = "vote" | "admin_action" | "delete_organization"

const ALLOWED_STEP_UP_OPERATIONS: ReadonlyArray<string> = ["vote", "admin_action", "delete_organization"]

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
  user: User
  /** Stable deployment provider key that authenticated this browser session. */
  providerId: string
  sessionId: string
  /** Browser-session organization-selection version, distinct from entity OCC. */
  sessionContextVersion: bigint
  authContext?: StepUpContext
}

export type AuthenticatedAgent = {
  entityType: "agent"
  agent: Agent
}

export interface EntityReference {
  entityId: string
  entityType: "user" | "agent"
  organizationId: OrganizationId
}

export type Actor =
  | {readonly type: "user"; readonly id: string; readonly displayName: string}
  | {readonly type: "agent"; readonly id: string; readonly displayName: string}
  | {readonly type: "operator"; readonly id: string; readonly displayName: string}
  // A system actor represents work performed by an internal service or worker
  // when no human or tenant agent is the initiating principal.
  | {readonly type: "system"; readonly displayName: string}

export type OriginatingActor = Extract<Actor, {readonly type: "user" | "agent" | "operator"}>

export function isOriginatingActor(data: unknown): data is OriginatingActor {
  return (
    isObject(data) &&
    hasOwnProperty(data, "id") &&
    typeof data.id === "string" &&
    hasOwnProperty(data, "type") &&
    (data.type === "user" || data.type === "agent" || data.type === "operator") &&
    hasOwnProperty(data, "displayName") &&
    typeof data.displayName === "string"
  )
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
    entityType: getEntityType(entity),
    organizationId: entity.entityType === "user" ? entity.user.organizationId : entity.agent.organizationId
  }
}

/**
 * Returns a normalized unique identifier for the entity across all entity types.
 * Format: "type:id" where type is the entity type and id is the actual entity id.
 * This ensures uniqueness even if users and agents have the same UUID.
 */
export function getNormalizedEntityId(entity: AuthenticatedEntity | EntityReference): string {
  if ("entityId" in entity) return `${entity.entityType}:${entity.entityId}`
  return `${entity.entityType}:${getEntityId(entity)}`
}
