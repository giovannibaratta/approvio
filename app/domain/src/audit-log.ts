import {Either, left, right} from "fp-ts/Either"
import {PrefixUnion, DistributiveOmit, isObject, hasOwnProperty, isDate, isUUIDv7} from "@utils"
import {v7 as uuidv7} from "uuid"
import {Actor, EntityReference} from "./authenticated-entity"
import {RoleScope, RoleFactory} from "./role"

export type AuditType =
  | "SPACE_CREATED"
  | "SPACE_DELETED"
  | "GROUP_CREATED"
  | "MEMBERSHIPS_ADDED"
  | "MEMBERSHIPS_REMOVED"
  | "USER_ROLES_ASSIGNED"
  | "USER_ROLES_REMOVED"
  | "AGENT_ROLES_ASSIGNED"
  | "AGENT_ROLES_REMOVED"
  | "ORGANIZATION_CREATED"
  | "ORGANIZATION_UPDATED"
  | "ORGANIZATION_SUSPENDED"
  | "ORGANIZATION_RESUMED"
  | "ORGANIZATION_DELETION_REQUESTED"
  | "MEMBERSHIP_ADMITTED"
  | "MEMBERSHIP_ROLE_CHANGED"
  | "MEMBERSHIP_REMOVED"
  | "INVITATION_CREATED"
  | "INVITATION_REVOKED"
  | "INVITATION_ACCEPTED"
  | "AGENT_CREATED"
  | "AGENT_REVOKED"

export type EntityTypeAudit = "SPACE" | "GROUP" | "USER" | "AGENT" | "ORGANIZATION" | "MEMBERSHIP" | "INVITATION"
export type ActorType = Actor["type"]

/**
 * Base interface for audit logs.
 * We keep it as a base for internal reuse but specific logs should be defined
 * in the AuditLog union to ensure strict typing of auditType, entityType and payload.
 */
interface BaseAuditLog {
  id: string
  organizationId: string
  auditType: AuditType
  entityType: EntityTypeAudit
  entityId: string
  actor: Actor
  createdAt: Date
  payload: Record<string, unknown>
}

export interface SpaceCreatedAuditLog extends BaseAuditLog {
  auditType: "SPACE_CREATED"
  entityType: "SPACE"
  payload: {
    name: string
    description?: string | null
  }
}

export interface SpaceDeletedAuditLog extends BaseAuditLog {
  auditType: "SPACE_DELETED"
  entityType: "SPACE"
  payload: Record<string, never> // Empty object
}

export interface GroupCreatedAuditLog extends BaseAuditLog {
  auditType: "GROUP_CREATED"
  entityType: "GROUP"
  payload: {
    name: string
    description?: string | null
  }
}

export interface MembershipsAddedAuditLog extends BaseAuditLog {
  auditType: "MEMBERSHIPS_ADDED"
  entityType: "GROUP"
  payload: {
    members: Array<EntityReference>
  }
}

export interface MembershipsRemovedAuditLog extends BaseAuditLog {
  auditType: "MEMBERSHIPS_REMOVED"
  entityType: "GROUP"
  payload: {
    members: Array<EntityReference>
  }
}

export interface UserRolesAssignedAuditLog extends BaseAuditLog {
  auditType: "USER_ROLES_ASSIGNED"
  entityType: "USER"
  payload: {
    roles: Array<{roleName: string; scope: RoleScope}>
  }
}

export interface UserRolesRemovedAuditLog extends BaseAuditLog {
  auditType: "USER_ROLES_REMOVED"
  entityType: "USER"
  payload: {
    roles: Array<{roleName: string; scope: RoleScope}>
  }
}

export interface AgentRolesAssignedAuditLog extends BaseAuditLog {
  auditType: "AGENT_ROLES_ASSIGNED"
  entityType: "AGENT"
  payload: {
    roles: Array<{roleName: string; scope: RoleScope}>
  }
}

export interface AgentRolesRemovedAuditLog extends BaseAuditLog {
  auditType: "AGENT_ROLES_REMOVED"
  entityType: "AGENT"
  payload: {
    roles: Array<{roleName: string; scope: RoleScope}>
  }
}

export interface OrganizationAuditLog extends BaseAuditLog {
  auditType:
    | "ORGANIZATION_CREATED"
    | "ORGANIZATION_UPDATED"
    | "ORGANIZATION_SUSPENDED"
    | "ORGANIZATION_RESUMED"
    | "ORGANIZATION_DELETION_REQUESTED"
  entityType: "ORGANIZATION"
}

export interface MembershipAuditLog extends BaseAuditLog {
  auditType: "MEMBERSHIP_ADMITTED" | "MEMBERSHIP_ROLE_CHANGED" | "MEMBERSHIP_REMOVED"
  entityType: "MEMBERSHIP"
}

export interface InvitationAuditLog extends BaseAuditLog {
  auditType: "INVITATION_CREATED" | "INVITATION_REVOKED" | "INVITATION_ACCEPTED"
  entityType: "INVITATION"
}

export interface AgentLifecycleAuditLog extends BaseAuditLog {
  auditType: "AGENT_CREATED" | "AGENT_REVOKED"
  entityType: "AGENT"
}

export type AuditLog =
  | SpaceCreatedAuditLog
  | SpaceDeletedAuditLog
  | GroupCreatedAuditLog
  | MembershipsAddedAuditLog
  | MembershipsRemovedAuditLog
  | UserRolesAssignedAuditLog
  | UserRolesRemovedAuditLog
  | AgentRolesAssignedAuditLog
  | AgentRolesRemovedAuditLog
  | OrganizationAuditLog
  | MembershipAuditLog
  | InvitationAuditLog
  | AgentLifecycleAuditLog

export type CreateAuditLog = DistributiveOmit<AuditLog, "id">

export type AuditLogValidationError = PrefixUnion<
  "audit_log",
  | "malformed_object"
  | "invalid_audit_type"
  | "invalid_entity_type"
  | "invalid_actor_type"
  | "invalid_payload"
  | "missing_required_fields"
  | "organization_mismatch"
>

export class AuditLogFactory {
  static create(data: DistributiveOmit<CreateAuditLog, "createdAt">): Either<AuditLogValidationError, AuditLog> {
    const auditLog = {
      createdAt: new Date(),
      id: uuidv7(),
      ...data
    }

    return AuditLogFactory.validate(auditLog)
  }

  static validate(data: unknown): Either<AuditLogValidationError, AuditLog> {
    if (!isObject(data)) return left("audit_log_malformed_object")
    if (!AuditLogFactory.isBaseAuditLog(data)) return left("audit_log_missing_required_fields")

    switch (data.auditType) {
      case "SPACE_CREATED":
        return AuditLogFactory.validateSpaceCreated(data)
      case "SPACE_DELETED":
        return AuditLogFactory.validateSpaceDeleted(data)
      case "GROUP_CREATED":
        return AuditLogFactory.validateGroupCreated(data)
      case "MEMBERSHIPS_ADDED":
        return AuditLogFactory.validateMembershipsAdded(data)
      case "MEMBERSHIPS_REMOVED":
        return AuditLogFactory.validateMembershipsRemoved(data)
      case "USER_ROLES_ASSIGNED":
        return AuditLogFactory.validateUserRolesAssigned(data)
      case "USER_ROLES_REMOVED":
        return AuditLogFactory.validateUserRolesRemoved(data)
      case "AGENT_ROLES_ASSIGNED":
        return AuditLogFactory.validateAgentRolesAssigned(data)
      case "AGENT_ROLES_REMOVED":
        return AuditLogFactory.validateAgentRolesRemoved(data)
      case "ORGANIZATION_CREATED":
      case "ORGANIZATION_UPDATED":
      case "ORGANIZATION_SUSPENDED":
      case "ORGANIZATION_RESUMED":
      case "ORGANIZATION_DELETION_REQUESTED":
        return data.entityType === "ORGANIZATION"
          ? right({...data, auditType: data.auditType, entityType: "ORGANIZATION"})
          : left("audit_log_invalid_entity_type")
      case "MEMBERSHIP_ADMITTED":
      case "MEMBERSHIP_ROLE_CHANGED":
      case "MEMBERSHIP_REMOVED":
        return data.entityType === "MEMBERSHIP"
          ? right({...data, auditType: data.auditType, entityType: "MEMBERSHIP"})
          : left("audit_log_invalid_entity_type")
      case "INVITATION_CREATED":
      case "INVITATION_REVOKED":
      case "INVITATION_ACCEPTED":
        return data.entityType === "INVITATION"
          ? right({...data, auditType: data.auditType, entityType: "INVITATION"})
          : left("audit_log_invalid_entity_type")
      case "AGENT_CREATED":
      case "AGENT_REVOKED":
        return data.entityType === "AGENT"
          ? right({...data, auditType: data.auditType, entityType: "AGENT"})
          : left("audit_log_invalid_entity_type")
    }
  }

  private static isBaseAuditLog(data: unknown): data is BaseAuditLog {
    return (
      isObject(data) &&
      AuditLogFactory.hasValidIdentityFields(data) &&
      hasOwnProperty(data, "actor") &&
      AuditLogFactory.isActor(data.actor) &&
      hasOwnProperty(data, "createdAt") &&
      isDate(data.createdAt) &&
      hasOwnProperty(data, "payload") &&
      isObject(data.payload)
    )
  }

  private static hasValidIdentityFields(data: Record<string, unknown>): boolean {
    return (
      hasOwnProperty(data, "id") &&
      typeof data.id === "string" &&
      hasOwnProperty(data, "organizationId") &&
      typeof data.organizationId === "string" &&
      isUUIDv7(data.organizationId) &&
      hasOwnProperty(data, "auditType") &&
      typeof data.auditType === "string" &&
      isAuditType(data.auditType) &&
      hasOwnProperty(data, "entityType") &&
      typeof data.entityType === "string" &&
      isEntityTypeAudit(data.entityType) &&
      hasOwnProperty(data, "entityId") &&
      typeof data.entityId === "string"
    )
  }

  private static isActor(data: unknown): data is Actor {
    return (
      isObject(data) &&
      hasOwnProperty(data, "id") &&
      typeof data.id === "string" &&
      hasOwnProperty(data, "type") &&
      typeof data.type === "string" &&
      (data.type === "user" || data.type === "agent" || data.type === "operator" || data.type === "system") &&
      hasOwnProperty(data, "displayName") &&
      typeof data.displayName === "string"
    )
  }

  private static validateSpaceCreated(data: BaseAuditLog): Either<AuditLogValidationError, SpaceCreatedAuditLog> {
    if (AuditLogFactory.isSpaceCreated(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isSpaceCreated(data: BaseAuditLog): data is SpaceCreatedAuditLog {
    return (
      data.auditType === "SPACE_CREATED" &&
      data.entityType === "SPACE" &&
      typeof data.payload.name === "string" &&
      (data.payload.description === undefined ||
        data.payload.description === null ||
        typeof data.payload.description === "string")
    )
  }

  private static validateSpaceDeleted(data: BaseAuditLog): Either<AuditLogValidationError, SpaceDeletedAuditLog> {
    if (AuditLogFactory.isSpaceDeleted(data)) return right(data)
    return left("audit_log_invalid_audit_type")
  }

  private static isSpaceDeleted(data: BaseAuditLog): data is SpaceDeletedAuditLog {
    return data.auditType === "SPACE_DELETED" && data.entityType === "SPACE"
  }

  private static validateGroupCreated(data: BaseAuditLog): Either<AuditLogValidationError, GroupCreatedAuditLog> {
    if (AuditLogFactory.isGroupCreated(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isGroupCreated(data: BaseAuditLog): data is GroupCreatedAuditLog {
    return (
      data.auditType === "GROUP_CREATED" &&
      data.entityType === "GROUP" &&
      typeof data.payload.name === "string" &&
      (data.payload.description === undefined ||
        data.payload.description === null ||
        typeof data.payload.description === "string")
    )
  }

  private static validateMembershipsAdded(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, MembershipsAddedAuditLog> {
    if (AuditLogFactory.isMembershipsAdded(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isMembershipsAdded(data: BaseAuditLog): data is MembershipsAddedAuditLog {
    return (
      data.auditType === "MEMBERSHIPS_ADDED" &&
      data.entityType === "GROUP" &&
      Array.isArray(data.payload.members) &&
      data.payload.members.every(
        (m: Record<string, unknown>) =>
          isObject(m) &&
          typeof m.entityId === "string" &&
          (m.entityType === "user" || m.entityType === "agent") &&
          m.organizationId === data.organizationId
      )
    )
  }

  private static validateMembershipsRemoved(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, MembershipsRemovedAuditLog> {
    if (AuditLogFactory.isMembershipsRemoved(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isMembershipsRemoved(data: BaseAuditLog): data is MembershipsRemovedAuditLog {
    return (
      data.auditType === "MEMBERSHIPS_REMOVED" &&
      data.entityType === "GROUP" &&
      Array.isArray(data.payload.members) &&
      data.payload.members.every(
        (m: Record<string, unknown>) =>
          isObject(m) &&
          typeof m.entityId === "string" &&
          (m.entityType === "user" || m.entityType === "agent") &&
          m.organizationId === data.organizationId
      )
    )
  }

  private static validateUserRolesAssigned(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, UserRolesAssignedAuditLog> {
    if (AuditLogFactory.isUserRolesAssigned(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isUserRolesAssigned(data: BaseAuditLog): data is UserRolesAssignedAuditLog {
    return (
      data.auditType === "USER_ROLES_ASSIGNED" &&
      data.entityType === "USER" &&
      Array.isArray(data.payload.roles) &&
      data.payload.roles.every(
        (r: Record<string, unknown>) =>
          isObject(r) &&
          typeof r.roleName === "string" &&
          RoleFactory.isValidRoleScope(r.scope) &&
          r.scope.organizationId === data.organizationId
      )
    )
  }

  private static validateUserRolesRemoved(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, UserRolesRemovedAuditLog> {
    if (AuditLogFactory.isUserRolesRemoved(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isUserRolesRemoved(data: BaseAuditLog): data is UserRolesRemovedAuditLog {
    return (
      data.auditType === "USER_ROLES_REMOVED" &&
      data.entityType === "USER" &&
      Array.isArray(data.payload.roles) &&
      data.payload.roles.every(
        (r: Record<string, unknown>) =>
          isObject(r) &&
          typeof r.roleName === "string" &&
          RoleFactory.isValidRoleScope(r.scope) &&
          r.scope.organizationId === data.organizationId
      )
    )
  }

  private static validateAgentRolesAssigned(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, AgentRolesAssignedAuditLog> {
    if (AuditLogFactory.isAgentRolesAssigned(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isAgentRolesAssigned(data: BaseAuditLog): data is AgentRolesAssignedAuditLog {
    return (
      data.auditType === "AGENT_ROLES_ASSIGNED" &&
      data.entityType === "AGENT" &&
      Array.isArray(data.payload.roles) &&
      data.payload.roles.every(
        (r: Record<string, unknown>) =>
          isObject(r) &&
          typeof r.roleName === "string" &&
          RoleFactory.isValidRoleScope(r.scope) &&
          r.scope.organizationId === data.organizationId
      )
    )
  }

  private static validateAgentRolesRemoved(
    data: BaseAuditLog
  ): Either<AuditLogValidationError, AgentRolesRemovedAuditLog> {
    if (AuditLogFactory.isAgentRolesRemoved(data)) return right(data)
    return left("audit_log_invalid_payload")
  }

  private static isAgentRolesRemoved(data: BaseAuditLog): data is AgentRolesRemovedAuditLog {
    return (
      data.auditType === "AGENT_ROLES_REMOVED" &&
      data.entityType === "AGENT" &&
      Array.isArray(data.payload.roles) &&
      data.payload.roles.every(
        (r: Record<string, unknown>) =>
          isObject(r) &&
          typeof r.roleName === "string" &&
          RoleFactory.isValidRoleScope(r.scope) &&
          r.scope.organizationId === data.organizationId
      )
    )
  }

}

const AUDIT_TYPES: ReadonlySet<string> = new Set([
  "SPACE_CREATED",
  "SPACE_DELETED",
  "GROUP_CREATED",
  "MEMBERSHIPS_ADDED",
  "MEMBERSHIPS_REMOVED",
  "USER_ROLES_ASSIGNED",
  "USER_ROLES_REMOVED",
  "AGENT_ROLES_ASSIGNED",
  "AGENT_ROLES_REMOVED",
  "ORGANIZATION_CREATED",
  "ORGANIZATION_UPDATED",
  "ORGANIZATION_SUSPENDED",
  "ORGANIZATION_RESUMED",
  "ORGANIZATION_DELETION_REQUESTED",
  "MEMBERSHIP_ADMITTED",
  "MEMBERSHIP_ROLE_CHANGED",
  "MEMBERSHIP_REMOVED",
  "INVITATION_CREATED",
  "INVITATION_REVOKED",
  "INVITATION_ACCEPTED",
  "AGENT_CREATED",
  "AGENT_REVOKED"
])

function isAuditType(value: string): value is AuditType {
  return AUDIT_TYPES.has(value)
}

const ENTITY_TYPES: ReadonlySet<string> = new Set<EntityTypeAudit>([
  "SPACE",
  "GROUP",
  "USER",
  "AGENT",
  "ORGANIZATION",
  "MEMBERSHIP",
  "INVITATION"
])

function isEntityTypeAudit(value: string): value is EntityTypeAudit {
  return ENTITY_TYPES.has(value)
}
