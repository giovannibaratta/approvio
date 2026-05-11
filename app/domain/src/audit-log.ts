import {Either, left, right} from "fp-ts/Either"
import {PrefixUnion, DistributiveOmit, isObject, hasOwnProperty, isDate} from "@utils"
import {v7 as uuidv7} from "uuid"
import {EntityReference} from "./authenticated-entity"
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

export type EntityTypeAudit = "SPACE" | "GROUP" | "USER" | "AGENT"
export type ActorType = "user" | "agent"

export interface Actor {
  id: string
  type: ActorType
}

/**
 * Base interface for audit logs.
 * We keep it as a base for internal reuse but specific logs should be defined
 * in the AuditLog union to ensure strict typing of auditType, entityType and payload.
 */
interface BaseAuditLog {
  id: string
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

export type CreateAuditLog = DistributiveOmit<AuditLog, "id">

export type AuditLogValidationError = PrefixUnion<
  "audit_log",
  | "malformed_object"
  | "invalid_audit_type"
  | "invalid_entity_type"
  | "invalid_actor_type"
  | "invalid_payload"
  | "missing_required_fields"
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
    if (
      data.entityType !== "SPACE" &&
      data.entityType !== "GROUP" &&
      data.entityType !== "USER" &&
      data.entityType !== "AGENT"
    )
      return left("audit_log_invalid_entity_type")

    const actorType = data.actor.type
    if (actorType !== "user" && actorType !== "agent") return left("audit_log_invalid_actor_type")

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
    }
  }

  private static isBaseAuditLog(data: unknown): data is BaseAuditLog {
    return (
      isObject(data) &&
      hasOwnProperty(data, "id") &&
      typeof data.id === "string" &&
      hasOwnProperty(data, "auditType") &&
      typeof data.auditType === "string" &&
      hasOwnProperty(data, "entityType") &&
      typeof data.entityType === "string" &&
      hasOwnProperty(data, "entityId") &&
      typeof data.entityId === "string" &&
      hasOwnProperty(data, "actor") &&
      isObject(data.actor) &&
      hasOwnProperty(data.actor, "id") &&
      typeof data.actor.id === "string" &&
      hasOwnProperty(data.actor, "type") &&
      typeof data.actor.type === "string" &&
      hasOwnProperty(data, "createdAt") &&
      isDate(data.createdAt) &&
      hasOwnProperty(data, "payload") &&
      isObject(data.payload)
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
          isObject(m) && typeof m.entityId === "string" && (m.entityType === "user" || m.entityType === "agent")
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
          isObject(m) && typeof m.entityId === "string" && (m.entityType === "user" || m.entityType === "agent")
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
          isObject(r) && typeof r.roleName === "string" && RoleFactory["isValidRoleScope"](r.scope)
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
          isObject(r) && typeof r.roleName === "string" && RoleFactory.isValidRoleScope(r.scope)
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
          isObject(r) && typeof r.roleName === "string" && RoleFactory.isValidRoleScope(r.scope)
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
          isObject(r) && typeof r.roleName === "string" && RoleFactory.isValidRoleScope(r.scope)
      )
    )
  }
}
