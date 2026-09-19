import {Account, User, Agent, UnconstrainedBoundRole, TenantContext} from "@domain"
import {Brand, brand, hasOwnProperty, isObject, isUUIDv7} from "@utils"
import {Either, left, right} from "fp-ts/Either"

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
  providerConnectionId: string
  contextVersion: string
}

/** Credentials that may read or switch their own browser session context. */
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
  /** Immutable provider connection that authenticated this browser session. */
  providerId: string
  sessionId: string
  /** Browser-session organization-selection version, distinct from entity OCC. */
  contextVersion: string
  authContext?: StepUpContext
}

export type AuthenticatedAgent = {
  entityType: "agent"
  agent: Agent
}

export interface EntityReference {
  entityId: string
  entityType: "user" | "agent"
  organizationId: string
}

/**
 * Credentials are deliberately split by authority boundary: platform-user is
 * global account/session authority, tenant-user is a membership-bound browser
 * credential, and tenant-agent is an organization-bound machine credential.
 */
export type Credential =
  | {readonly kind: "platform-user"; readonly accountId: string; readonly sessionId: string}
  | {
      readonly kind: "tenant-user"
      readonly accountId: string
      readonly userId: string
      readonly organizationId: string
      readonly sessionId: string
      readonly occ: string
    }
  | {
      readonly kind: "tenant-agent"
      readonly agentId: string
      readonly organizationId: string
      readonly credentialId: string
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

declare const _TenantPrincipalBrand: unique symbol

interface TenantPrincipalData extends TenantContext {
  readonly credential: Credential
  readonly actor: Actor
}

/**
 * Represents an admitted tenant principal.
 *
 * Separating `credential` from `actor` decouples authentication session state
 * (e.g. session IDs, OCC tokens, credential IDs) from the audit identity (user/agent
 * ID and displayName). Freezing both snapshots at admission ensures audit logs
 * reflect the actor's exact displayName and identity at the time the request was
 * admitted, even if the actor updates their profile or credentials later.
 */
export type TenantPrincipal = Brand<TenantPrincipalData, typeof _TenantPrincipalBrand>

export type TenantPrincipalValidationError =
  | "principal_malformed_object"
  | "principal_invalid_organization_id"
  | "principal_organization_mismatch"
  | "principal_invalid_credential"
  | "principal_invalid_actor"
  | "principal_actor_credential_mismatch"

export class TenantPrincipalFactory {
  /**
   * Constructs and brands a validated TenantPrincipal from its verified components.
   * Ensures the credential and actor match (e.g., tenant-user credential paired with user actor,
   * tenant-agent credential paired with agent actor) and organization boundaries match.
   */
  static fromVerified(input: {
    readonly organizationId: string
    readonly credential: Credential
    readonly actor: Actor
  }): Either<TenantPrincipalValidationError, TenantPrincipal> {
    if (!isUUIDv7(input.organizationId)) return left("principal_invalid_organization_id")

    if (input.credential.kind === "tenant-user") {
      if (input.credential.organizationId !== input.organizationId) return left("principal_organization_mismatch")

      if (input.actor.type !== "user" || input.actor.id !== input.credential.userId)
        return left("principal_actor_credential_mismatch")
    } else if (input.credential.kind === "tenant-agent") {
      if (input.credential.organizationId !== input.organizationId) return left("principal_organization_mismatch")

      if (input.actor.type !== "agent" || input.actor.id !== input.credential.agentId)
        return left("principal_actor_credential_mismatch")
    } else if (input.credential.kind === "platform-user") return left("principal_invalid_credential")

    const data = {
      organizationId: input.organizationId,
      credential: input.credential,
      actor: input.actor
    } satisfies TenantPrincipalData

    return right(brand<TenantPrincipalData, typeof _TenantPrincipalBrand>(data))
  }
}

/** Operations for which the authority resolver admits or rechecks a tenant principal. */
export type AdmissionOperation =
  "resource" | "management_summary" | "membership_recovery" | "resume" | "delete" | "vote" | "authority_change"

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
