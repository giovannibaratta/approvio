import {Inject, Injectable} from "@nestjs/common"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN, ListAuditLogResponse, FindManyError} from "./interfaces"
import {AuthenticatedEntity} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {AuthorizationError} from "../error"
import {logSuccess} from "@utils"
import {pipe} from "fp-ts/function"

const MAX_HISTORY = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds

@Injectable()
export class AuditLogService {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
  ) {}

  public listAuditLogs(
    requestor: AuthenticatedEntity,
    request: ListAuditLogsRequest
  ): TaskEither<AuditLogListError, ListAuditLogResponse> {
    if (requestor.entityType !== "user" || requestor.user.orgRole !== "admin")
      return TE.left("requestor_not_authorized" as const)

    const fromDate = new Date(Date.now() - MAX_HISTORY)

    return pipe(
      this.auditLogRepo.findMany(request.limit, fromDate, request.cursor, {
        targets: request.targets,
        actors: request.actors,
        auditTypes: request.auditTypes
      }),
      logSuccess("Audit logs listed by admin", "AuditLogService", result => ({
        hasMore: result.hasMore,
        returned: result.items.length
      }))
    )
  }

  public listMyAuditLogs(
    requestor: AuthenticatedEntity,
    request: ListMyAuditLogsRequest
  ): TaskEither<AuditLogListError, ListAuditLogResponse> {
    const actorId = requestor.entityType === "user" ? requestor.user.id : requestor.agent.id
    const fromDate = new Date(Date.now() - MAX_HISTORY)

    return pipe(
      this.auditLogRepo.findMany(request.limit, fromDate, request.cursor, {
        targets: request.targets,
        actors: [{actorType: requestor.entityType, actorId}],
        auditTypes: request.auditTypes
      }),
      logSuccess("Audit logs listed by self", "AuditLogService", result => ({
        hasMore: result.hasMore,
        returned: result.items.length
      }))
    )
  }
}

export type AuditLogListError = AuthorizationError | FindManyError

export interface ListAuditLogsRequest {
  cursor?: string
  limit: number
  targets?: Array<{entityType: string; entityId: string}>
  actors?: Array<{actorType: string; actorId: string}>
  auditTypes?: string[]
}

export interface ListMyAuditLogsRequest {
  cursor?: string
  limit: number
  targets?: Array<{entityType: string; entityId: string}>
  auditTypes?: string[]
}
