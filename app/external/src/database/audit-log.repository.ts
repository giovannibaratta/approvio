import {Injectable} from "@nestjs/common"
import {AuditLogRepository, UnknownError} from "@services"
import {AuditLog, CreateAuditLog} from "@domain"
import {DatabaseClient} from "./database-client"
import {v7 as uuidv7} from "uuid"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {AuditLog as PrismaAuditLog, Prisma} from "@prisma/client"
import {Logger} from "@nestjs/common"
import {mapToJsonValue} from "./shared/json-mappers"

@Injectable()
export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  public persist(data: CreateAuditLog): TaskEither<UnknownError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.auditLog.create({
          data: {
            id: uuidv7(),
            auditType: data.auditType,
            entityType: data.entityType,
            entityId: data.entityId,
            actorId: data.actorId,
            actorType: data.actorType,
            payload: mapToJsonValue(data.payload),
            createdAt: data.createdAt
          },
          select: {id: true}
        })
        return
      },
      e => {
        Logger.error(e)
        return "unknown_error" as const
      }
    )
  }

  public findMany(filters: {
    entityId?: string
    entityType?: string
    actorId?: string
  }): TaskEither<UnknownError, AuditLog[]> {
    return TE.tryCatch(
      async () => {
        const where: Prisma.AuditLogWhereInput = {}
        if (filters.entityId) where.entityId = filters.entityId
        if (filters.entityType) where.entityType = filters.entityType
        if (filters.actorId) where.actorId = filters.actorId

        const results = await this.dbClient.cx.auditLog.findMany({
          where,
          orderBy: {createdAt: "desc"}
        })
        return results.map((r: PrismaAuditLog) => this.mapToDomain(r))
      },
      e => {
        Logger.error(e)
        return "unknown_error" as const
      }
    )
  }

  private mapToDomain(record: PrismaAuditLog): AuditLog {
    return {
      id: record.id,
      auditType: record.auditType,
      entityType: record.entityType,
      entityId: record.entityId,
      actorId: record.actorId,
      actorType: record.actorType,
      // TODO: This must be replaced with proper validation once the audit types
      // will be defined
      payload: record.payload as Record<string, unknown>,
      createdAt: record.createdAt
    }
  }
}
