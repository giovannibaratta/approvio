import {Group, GroupWithEntitiesCount, HumanGroupMembershipRole, ListGroupsFilter} from "@domain"
import {isPrismaForeignKeyConstraintError, isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup} from "@prisma/client"
import {
  CreateGroupRepoError,
  CreateGroupWithOwnerRepo,
  GetGroupByIdRepo,
  GetGroupByNameRepo,
  GetGroupRepoError,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult
} from "@services"
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
  filter: ListGroupsFilter
}

export type PrismaGroupWithCount = PrismaGroup & {
  _count: {
    groupMemberships: number
  }
}

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createGroupWithOwner(data: CreateGroupWithOwnerRepo): TaskEither<CreateGroupRepoError, Group> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistNewGroupWithOwnerTask()),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  private persistNewGroupWithOwnerTask(): (
    data: CreateGroupWithOwnerRepo
  ) => TaskEither<CreateGroupRepoError, PrismaGroupWithCount> {
    // Wrap in a lambda to preserve the "this" context
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.$transaction(async tx => {
            // 1. Create the group
            const createdGroup = await tx.group.create({
              data: {
                createdAt: data.group.createdAt,
                id: data.group.id,
                name: data.group.name,
                description: data.group.description,
                updatedAt: data.group.updatedAt,
                occ: POSTGRES_BIGINT_LOWER_BOUND
              },
              include: {
                // Include count for mapping later
                _count: {
                  select: {
                    groupMemberships: true
                  }
                }
              }
            })

            // 2. Add owner membership
            await tx.groupMembership.create({
              data: {
                groupId: createdGroup.id,
                userId: data.requestor.id,
                role: HumanGroupMembershipRole.OWNER,
                createdAt: data.group.createdAt,
                updatedAt: data.group.updatedAt
              }
            })

            return createdGroup
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "group_already_exists"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user (index)")) return "user_not_found"

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  getGroupById(data: GetGroupByIdRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "id", identifier: data.groupId}
    return this.getGroup({identifier, onlyIfMember: data.onlyIfMember})
  }

  getGroupByName(data: GetGroupByNameRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "name", identifier: data.groupName}
    return this.getGroup({identifier, onlyIfMember: data.onlyIfMember})
  }

  private getGroup(request: GetObjectTaskRequest): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  listGroups(data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult> {
    const {page, limit, filter} = data

    const skip = (page - 1) * limit
    const take = limit

    const options: ListOptions = {
      take,
      skip,
      filter
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

  private buildWhereClauseGetObjectTask(request: GetObjectTaskRequest): Prisma.GroupWhereUniqueInput {
    const idClause =
      request.identifier.type === "id"
        ? {
            id: request.identifier.identifier
          }
        : {
            name: request.identifier.identifier
          }

    let groupMembershipClause: Prisma.GroupWhereUniqueInput["groupMemberships"] = undefined

    if (request.onlyIfMember) {
      groupMembershipClause = {
        some: {
          userId: request.onlyIfMember.userId
        }
      }
    }

    return {
      ...idClause,
      groupMemberships: groupMembershipClause
    }
  }

  private getObjectTask(): (
    request: GetObjectTaskRequest
  ) => TaskEither<GetGroupRepoError, PrismaGroupWithCount | null> {
    // Wrap in a lambda to preserve the "this" context
    return request =>
      TE.tryCatchK(
        () =>
          this.dbClient.group.findUnique({
            where: this.buildWhereClauseGetObjectTask(request),
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

  private getObjectsTask(): (
    options: ListOptions
  ) => TaskEither<ListGroupsRepoError, [PrismaGroupWithCount[], number]> {
    // Wrap in a lambda to preserve the "this" context
    return options =>
      TE.tryCatchK(
        () => {
          const whereClause: Prisma.GroupWhereInput = this.buildWhereCloseForListingGroups(options.filter)

          const data = this.dbClient.group.findMany({
            take: options.take,
            skip: options.skip,
            orderBy: {
              createdAt: "asc"
            },
            where: whereClause,
            include: {
              _count: {
                select: {
                  groupMemberships: true
                }
              }
            }
          })
          const stats = this.dbClient.group.count({where: whereClause})

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

  private buildWhereCloseForListingGroups(filter: ListGroupsFilter): Prisma.GroupWhereInput {
    switch (filter.type) {
      case "all":
        return {}
      case "direct_member":
        return {
          groupMemberships: {
            some: {
              userId: filter.requestor.id
            }
          }
        }
    }
  }
}

interface GetObjectTaskRequest {
  identifier: Identifier
  onlyIfMember: GetGroupByIdRepo["onlyIfMember"] | GetGroupByNameRepo["onlyIfMember"]
}
