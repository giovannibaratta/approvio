import {Group, GroupWithEntititesCount} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup} from "@prisma/client"
import {GroupCreateError, GroupGetError, GroupListError, GroupRepository, ListGroupsResult} from "@services"
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/lib/Either"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedGroupWithEntities} from "./shared"
import {areAllRights, chainNullableToLeft} from "./utils"

interface Identifier {
  identifier: string
  type: "id" | "name"
}

interface ListOptions {
  take: number
  skip: number
}

export type PrismaGroupWithCount = PrismaGroup & {
  _count: {
    groupMemberships: number
  }
}

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createGroup(group: Group): TaskEither<GroupCreateError, Group> {
    return pipe(
      group,
      TE.right,
      TE.chainW(this.persistNewObjectTask()),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  getGroupById(groupId: string): TaskEither<GroupGetError, Versioned<GroupWithEntititesCount>> {
    const identifier: Identifier = {type: "id", identifier: groupId}
    return this.getGroup(identifier)
  }

  getGroupByName(groupName: string): TaskEither<GroupGetError, Versioned<GroupWithEntititesCount>> {
    const identifier: Identifier = {type: "name", identifier: groupName}
    return this.getGroup(identifier)
  }

  private getGroup(identifier: Identifier): TaskEither<GroupGetError, Versioned<GroupWithEntititesCount>> {
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  listGroups(page: number, limit: number): TaskEither<GroupListError, ListGroupsResult> {
    const skip = (page - 1) * limit
    const take = limit

    const options: ListOptions = {
      take,
      skip
    }

    return pipe(
      options,
      TE.right,
      TE.chainW(this.getObjectsTask()),
      TE.chainEitherKW(([groups, total]) => {
        const domainGroups = groups.map(group => mapToDomainVersionedGroupWithEntities(group))

        if (areAllRights(domainGroups)) {
          const mappedToDomain = {
            groups: domainGroups.map(e => e.right),
            total,
            page,
            limit
          }
          return E.right(mappedToDomain)
        }

        const lefts = domainGroups.filter(e => isLeft(e))
        const firstLeft = lefts[0]
        if (firstLeft === undefined) throw new Error("Unexpected error: No rights and no lefts")
        return firstLeft
      })
    )
  }

  private persistNewObjectTask(): (group: Group) => TaskEither<GroupCreateError, PrismaGroupWithCount> {
    // Wrap in a lambda to preserve the "this" context
    return group =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.create({
            data: {
              createdAt: group.createdAt,
              id: group.id,
              name: group.name,
              description: group.description,
              updatedAt: group.updatedAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND
            },
            include: {
              _count: {
                select: {
                  groupMemberships: true
                }
              }
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "group_already_exists"

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private getObjectTask(): (identifier: Identifier) => TaskEither<GroupGetError, PrismaGroupWithCount | null> {
    // Wrap in a lambda to preserve the "this" context
    return identifier =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              name: identifier.type === "name" ? identifier.identifier : undefined
            },
            include: {
              _count: {
                select: {
                  groupMemberships: true
                }
              }
            }
          }),
        error => {
          Logger.error("Error while retrieving group. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private getObjectsTask(): (options: ListOptions) => TaskEither<GroupListError, [PrismaGroupWithCount[], number]> {
    // Wrap in a lambda to preserve the "this" context
    return options =>
      TE.tryCatchK(
        () => {
          const data = this.dbClient.group.findMany({
            take: options.take,
            skip: options.skip,
            orderBy: {
              createdAt: "asc"
            },
            include: {
              _count: {
                select: {
                  groupMemberships: true
                }
              }
            }
          })
          const stats = this.dbClient.group.count()

          return this.dbClient.$transaction([data, stats], {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
          })
        },
        error => {
          Logger.error("Error while retrieving groups. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }
}
