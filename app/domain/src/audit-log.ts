import {Either, left, right} from "fp-ts/Either"
import {PrefixUnion, DistributiveOmit, isObject, hasOwnProperty, isDate} from "@utils"

export type AuditType = "SPACE_CREATED" | "SPACE_DELETED"
export type EntityTypeAudit = "SPACE"
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

export type AuditLog = SpaceCreatedAuditLog | SpaceDeletedAuditLog

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
  static validate(data: unknown): Either<AuditLogValidationError, AuditLog> {
    if (!isObject(data)) return left("audit_log_malformed_object")

    if (!AuditLogFactory.isBaseAuditLog(data)) return left("audit_log_missing_required_fields")
    if (data.entityType !== "SPACE") return left("audit_log_invalid_entity_type")

    const actorType = data.actor.type
    if (actorType !== "user" && actorType !== "agent") return left("audit_log_invalid_actor_type")

    switch (data.auditType) {
      case "SPACE_CREATED":
        return AuditLogFactory.validateSpaceCreated(data)
      case "SPACE_DELETED":
        return AuditLogFactory.validateSpaceDeleted(data)
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
}
