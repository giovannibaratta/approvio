import {Group, GroupWithEntitiesCount, ListGroupsFilter} from "@domain"
import {
  isPrismaForeignKeyConstraintError,
  isPrismaRecordNotFoundError,
  isPrismaUniqueConstraintError
} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup} from "@prisma/client"
import {UnknownError} from "@services/error"
import {
  CreateGroupRepoError,
  CreateGroupWithMembershipAndUpdateUserRepo,
  GetGroupByIdRepo,
  GetGroupByNameRepo,
  GetGroupRepoError,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult
} from "@services"
import {Versioned} from "@domain"
import * as E from "fp-ts/Either"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as RA from "fp-ts/ReadonlyArray"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedGroupWithEntities} from "./shared"
import {persistExistingUserRaceConditionFree} from "./shared/user-operations"
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
    agentGroupMemberships: number
  }
}

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createGroupWithMembershipAndUpdateUser(
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TaskEither<CreateGroupRepoError, Group> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistNewGroupWithMembershipAndUpdateUserTask()),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  private persistNewGroupWithMembershipAndUpdateUserTask(): (
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ) => TaskEither<CreateGroupRepoError, PrismaGroupWithCount> {
    // Wrap in a lambda to preserve the "this" context
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.transactional(async tx => {
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
                    groupMemberships: true,
                    agentGroupMemberships: true
                  }
                }
              }
            })

            // 2. Add membership using provided data
            await tx.groupMembership.create({
              data: {
                groupId: createdGroup.id,
                userId: data.membership.getEntityId(),
                createdAt: data.membership.createdAt,
                updatedAt: data.membership.updatedAt
              }
            })

            // 3. Update user with all data using shared function
            await persistExistingUserRaceConditionFree(tx, {
              userId: data.user.id,
              userOcc: data.userOcc,
              displayName: data.user.displayName,
              email: data.user.email,
              roles: data.user.roles,
              createdAt: data.user.createdAt
            })

            return createdGroup
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["name"])) return "group_already_exists"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user")) return "user_not_found"

          // Handle OCC conflicts - P2025 means record not found (likely due to OCC mismatch)
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)) return "concurrency_error" as const

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  getGroupById(data: GetGroupByIdRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "id", identifier: data.groupId}
    return this.getGroup({identifier})
  }

  getGroupByName(data: GetGroupByNameRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "name", identifier: data.groupName}
    return this.getGroup({identifier})
  }

  getGroupIdByName(groupName: string): TaskEither<GetGroupRepoError, string> {
    return pipe(
      TE.tryCatchK(
        () =>
          this.dbClient.cx.group.findUnique({
            where: {name: groupName},
            select: {id: true}
          }),
        error => {
          Logger.error("Error while retrieving group ID by name. Unknown error", error)
          return "unknown_error" as const
        }
      )(),
      TE.chainW(result => {
        if (result === null) return TE.left("group_not_found" as const)
        return TE.right(result.id)
      })
    )
  }

  getGroupsByUserId(userId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      userId,
      TE.right,
      TE.chainW(this.getGroupsByUserIdTask()),
      TE.chainEitherKW(groups =>
        pipe(groups, RA.traverse(E.Applicative)(mapToDomainVersionedGroupWithEntities), E.map(RA.toArray))
      )
    )
  }

  private getGroupsByUserIdTask(): (userId: string) => TaskEither<GetGroupRepoError, PrismaGroupWithCount[]> {
    return userId =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.group.findMany({
            where: {
              groupMemberships: {
                some: {
                  userId
                }
              }
            },
            include: {
              _count: {
                select: {
                  groupMemberships: true,
                  agentGroupMemberships: true
                }
              }
            }
          }),
        error => {
          Logger.error("Error while retrieving user groups. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  getGroupsByAgentId(agentId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      agentId,
      TE.right,
      TE.chainW(this.getGroupsByAgentIdTask()),
      TE.chainEitherKW(groups =>
        pipe(groups, RA.traverse(E.Applicative)(mapToDomainVersionedGroupWithEntities), E.map(RA.toArray))
      )
    )
  }

  countGroups(): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () => this.dbClient.cx.group.count(),
      error => {
        Logger.error("Error counting groups", error)
        return "unknown_error"
      }
    )
  }

  private getGroupsByAgentIdTask(): (agentId: string) => TaskEither<GetGroupRepoError, PrismaGroupWithCount[]> {
    return agentId =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.group.findMany({
            where: {
              agentGroupMemberships: {
                some: {
                  agentId
                }
              }
            },
            include: {
              _count: {
                select: {
                  groupMemberships: true,
                  agentGroupMemberships: true
                }
              }
            }
          }),
        error => {
          Logger.error("Error while retrieving agent groups. Unknown error", error)
          return "unknown_error" as const
        }
      )()
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
    return request.identifier.type === "id"
      ? {id: request.identifier.identifier}
      : {name: request.identifier.identifier}
  }

  private getObjectTask(): (
    request: GetObjectTaskRequest
  ) => TaskEither<GetGroupRepoError, PrismaGroupWithCount | null> {
    // Wrap in a lambda to preserve the "this" context
    return request =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.group.findUnique({
            where: this.buildWhereClauseGetObjectTask(request),
            include: {
              _count: {
                select: {
                  groupMemberships: true,
                  agentGroupMemberships: true
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
        async () => {
          const whereClause: Prisma.GroupWhereInput = this.buildWhereCloseForListingGroups(options.filter)

          const data = this.dbClient.cx.group.findMany({
            take: options.take,
            skip: options.skip,
            orderBy: {
              createdAt: "asc"
            },
            where: whereClause,
            include: {
              _count: {
                select: {
                  groupMemberships: true,
                  agentGroupMemberships: true
                }
              }
            }
          })
          const stats = this.dbClient.cx.group.count({where: whereClause})

          const [resolvedData, resolvedStats] = await Promise.all([data, stats])
          return [
            resolvedData.map((item: PrismaGroupWithCount) => ({
              ...item,
              occ: BigInt(item.occ)
            })),
            resolvedStats
          ] as [PrismaGroupWithCount[], number]
        },
        error => {
          Logger.error("Error while retrieving groups. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private buildWhereCloseForListingGroups(filter: ListGroupsFilter): Prisma.GroupWhereInput {
    const baseWhere: Prisma.GroupWhereInput = filter.search
      ? {name: {contains: filter.search, mode: "insensitive"}}
      : {}

    switch (filter.type) {
      case "all":
        return baseWhere
      case "direct_member":
        return {
          ...baseWhere,
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
}
