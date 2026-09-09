import {TaskEither} from "fp-ts/TaskEither"
import {AuditLog, BoundaryError, CreateAuditLog, TenantContext} from "@domain"
import {UnknownError} from "../error"

export const AUDIT_LOG_REPOSITORY_TOKEN = "AUDIT_LOG_REPOSITORY_TOKEN"

export type FindManyError = BoundaryError | UnknownError | "invalid_cursor"

export interface AuditLogRepository {
  persist(context: TenantContext, data: CreateAuditLog): TaskEither<UnknownError | BoundaryError, void>
  findMany(
    context: TenantContext,
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
