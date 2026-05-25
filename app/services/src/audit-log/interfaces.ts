import {TaskEither} from "fp-ts/TaskEither"
import {AuditLog, CreateAuditLog} from "@domain"
import {UnknownError} from "../error"

export const AUDIT_LOG_REPOSITORY_TOKEN = "AUDIT_LOG_REPOSITORY_TOKEN"

export type FindManyError = UnknownError | "invalid_cursor"

export interface AuditLogRepository {
  persist(data: CreateAuditLog): TaskEither<UnknownError, void>
  findMany(
    limit: number,
    fromDate: Date,
    cursor: string | undefined,
    filters: {
      targets?: Array<{entityType: string; entityId: string}>
      actors?: Array<{actorType: string; actorId: string}>
      auditTypes?: string[]
    }
  ): TaskEither<FindManyError, ListAuditLogResponse>
}

type HasMore = {hasMore: true; nextCursor: string}
type ExhaustedResults = {hasMore: false}
export type ListAuditLogResponse = {items: AuditLog[]} & (HasMore | ExhaustedResults)
