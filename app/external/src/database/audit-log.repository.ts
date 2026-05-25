import {Injectable} from "@nestjs/common"
import {AuditLogRepository, FindManyError, ListAuditLogResponse, UnknownError} from "@services"
import {CreateAuditLog, AuditLogFactory} from "@domain"
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

  public findMany(
    limit: number,
    fromDate: Date,
    cursor: string | undefined,
    filters: {
      targets?: Array<{entityType: string; entityId: string}>
      actors?: Array<{actorType: string; actorId: string}>
      auditTypes?: string[]
    }
  ): TaskEither<FindManyError, ListAuditLogResponse> {
    return pipe(
      TE.tryCatch(
        async () => {
          // Fetch 'limit + 1' items to check if there is a next page without executing an extra count query.
          // If we receive 'limit + 1' items, we know there are more pages (hasMore = true) and slice
          // the extra element off before returning the payload to the caller.
          const take = limit + 1
          const decodedCursor = this.decodeCursor(cursor)
          const where = this.buildWhere(fromDate, filters, decodedCursor)

          const items = await this.dbClient.cx.auditLog.findMany({
            where,
            orderBy: [{createdAt: "desc"}, {id: "desc"}],
            take
          })

          const hasMore = items.length > limit
          const itemsToReturn = hasMore ? items.slice(0, limit) : items
          const lastItem = itemsToReturn[itemsToReturn.length - 1]
          const nextCursor = hasMore && lastItem ? this.encodeCursor(lastItem) : null

          return {items: itemsToReturn, hasMore, nextCursor}
        },
        e => {
          if (e instanceof InvalidCursorError) return "invalid_cursor" as const

          Logger.error(e)
          return "unknown_error" as const
        }
      ),
      TE.chainEitherKW(({items, hasMore, nextCursor}) =>
        pipe(
          items,
          A.traverse(E.Applicative)(record => this.mapToDomain(record)),
          E.map(domainItems => {
            if (hasMore && nextCursor) {
              return {
                items: domainItems,
                hasMore: true as const,
                nextCursor
              }
            }
            return {
              items: domainItems,
              hasMore: false as const
            }
          }),
          E.mapLeft(error => {
            Logger.error("Failed to map AuditLog record to domain", error)
            return "unknown_error" as const
          })
        )
      )
    )
  }

  private decodeCursor(cursorStr?: string): {createdAt: Date; id: string} | undefined {
    if (!cursorStr) return undefined

    let decoded: string

    try {
      decoded = Buffer.from(cursorStr, "base64").toString("utf-8")
    } catch {
      Logger.error("Failed to decode cursor", cursorStr)
      throw new InvalidCursorError()
    }

    const [createdAtStr, id] = decoded.split("_")
    if (!createdAtStr || !id) throw new InvalidCursorError()

    const createdAt = new Date(createdAtStr)
    if (isNaN(createdAt.getTime())) throw new InvalidCursorError()
    return {createdAt, id}
  }

  private encodeCursor(lastItem: PrismaAuditLog): string | null {
    return Buffer.from(`${lastItem.createdAt.toISOString()}_${lastItem.id}`).toString("base64")
  }

  private buildWhere(
    fromDate: Date,
    filters: {
      targets?: Array<{entityType: string; entityId: string}>
      actors?: Array<{actorType: string; actorId: string}>
      auditTypes?: string[]
    },
    cursor: {createdAt: Date; id: string} | undefined
  ): Prisma.AuditLogWhereInput {
    const andConditions: Prisma.AuditLogWhereInput[] = [{createdAt: {gte: fromDate}}]

    if (filters.targets && filters.targets.length > 0) {
      andConditions.push({
        OR: filters.targets.map(target => ({
          entityType: target.entityType,
          entityId: target.entityId
        }))
      })
    }

    if (filters.actors && filters.actors.length > 0) {
      andConditions.push({
        OR: filters.actors.map(actor => ({
          actorType: actor.actorType,
          actorId: actor.actorId
        }))
      })
    }

    if (filters.auditTypes && filters.auditTypes.length > 0) {
      andConditions.push({
        auditType: {in: filters.auditTypes}
      })
    }

    if (cursor) {
      andConditions.push({
        OR: [{createdAt: {lt: cursor.createdAt}}, {createdAt: cursor.createdAt, id: {lt: cursor.id}}]
      })
    }

    return {AND: andConditions}
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

class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor")
    this.name = "InvalidCursorError"
  }
}
