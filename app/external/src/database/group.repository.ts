import {Group, GroupWithEntitiesCount, ListGroupsFilter} from "@domain"
import {isPrismaForeignKeyConstraintError, isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, Group as PrismaGroup} from "@prisma/client"
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
import {Versioned} from "@services/shared/utils"
import * as E from "fp-ts/lib/Either"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
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
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            return "concurrency_error"
          }

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
          this.dbClient.group.findUnique({
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
}
