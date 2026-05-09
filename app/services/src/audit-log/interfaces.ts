import {TaskEither} from "fp-ts/TaskEither"
import {AuditLog, CreateAuditLog} from "@domain"
import {UnknownError} from "../error"

export const AUDIT_LOG_REPOSITORY_TOKEN = "AUDIT_LOG_REPOSITORY_TOKEN"

export interface AuditLogRepository {
  persist(data: CreateAuditLog): TaskEither<UnknownError, void>
  findMany(filters: {entityId?: string; entityType?: string; actorId?: string}): TaskEither<UnknownError, AuditLog[]>
}
