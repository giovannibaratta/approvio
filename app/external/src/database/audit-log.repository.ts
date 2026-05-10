import {Injectable} from "@nestjs/common"
import {AuditLogRepository, UnknownError} from "@services"
import {AuditLog, CreateAuditLog, AuditLogFactory} from "@domain"
import {DatabaseClient} from "./database-client"
import {v7 as uuidv7} from "uuid"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import * as A from "fp-ts/Array"
import {AuditLog as PrismaAuditLog, Prisma} from "@prisma/client"
import {Logger} from "@nestjs/common"
import {mapToJsonValue} from "./shared/json-mappers"
import {pipe} from "fp-ts/function"

@Injectable()
export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  public persist(data: CreateAuditLog): TaskEither<UnknownError, void> {
    return TE.tryCatch(
      async () => {
        await this.dbClient.cx.auditLog.create({
          data: this.mapToPrisma(data),
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
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.auditLog.findMany({
            where: this.buildWhere(filters),
            orderBy: {createdAt: "desc"}
          }),
        e => {
          Logger.error(e)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherK(results =>
        pipe(
          results,
          A.traverse(E.Applicative)(record => this.mapToDomain(record)),
          E.mapLeft(error => {
            Logger.error("Failed to map AuditLog record to domain", error)
            return "unknown_error" as const
          })
        )
      )
    )
  }

  private buildWhere(filters: {entityId?: string; entityType?: string; actorId?: string}): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {}
    if (filters.entityId) where.entityId = filters.entityId
    if (filters.entityType) where.entityType = filters.entityType
    if (filters.actorId) where.actorId = filters.actorId
    return where
  }

  private mapToPrisma(data: CreateAuditLog): Prisma.AuditLogCreateInput {
    return {
      id: uuidv7(),
      auditType: data.auditType,
      entityType: data.entityType,
      entityId: data.entityId,
      actorId: data.actor.id,
      actorType: data.actor.type,
      payload: mapToJsonValue(data.payload),
      createdAt: data.createdAt
    }
  }

  private mapToDomain(record: PrismaAuditLog) {
    return AuditLogFactory.validate({
      id: record.id,
      auditType: record.auditType,
      entityType: record.entityType,
      entityId: record.entityId,
      actor: {
        id: record.actorId,
        type: record.actorType
      },
      payload: record.payload,
      createdAt: record.createdAt
    })
  }
}
