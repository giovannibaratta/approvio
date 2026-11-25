import {fromEitherPromise, fromPromise} from "./repository-operation"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import * as RA from "fp-ts/ReadonlyArray"
import {TaskEither} from "fp-ts/TaskEither"
import {Injectable, Logger} from "@nestjs/common"
import {
  Group,
  GroupFactory,
  GroupWithEntitiesCount,
  GroupValidationError,
  ListGroupsFilter,
  TenantContext,
  Versioned
} from "@domain"
import {
  CreateGroupRepoError,
  CreateGroupWithMembershipAndUpdateUserRepo,
  GetGroupByIdRepo,
  GetGroupByNameRepo,
  GetGroupRepoError,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult,
  UnknownError
} from "@services"
import {Group as PrismaGroup, Prisma} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {GroupTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError, isPrismaForeignKeyConstraintError} from "./errors"
import {persistExistingUserRaceConditionFree} from "./shared"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: GroupTenantClient) {}

  createGroupWithMembershipAndUpdateUser(
    context: TenantContext,
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TaskEither<CreateGroupRepoError, Group> {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.persistNewGroupWithMembershipAndUpdateUserTask(context)),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  private persistNewGroupWithMembershipAndUpdateUserTask(
    context: TenantContext
  ): (data: CreateGroupWithMembershipAndUpdateUserRepo) => TaskEither<CreateGroupRepoError, PrismaGroupWithCount> {
    // Wrap in a lambda to preserve the "this" context
    return data =>
      fromEitherPromise(
        async () => {
          // 1. Create the group
          const createdGroup = await this.dbClient.cx.group.create({
            data: {
              organizationId: data.group.organizationId,
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
          await this.dbClient.cx.groupMembership.create({
            data: {
              organizationId: context.organizationId,
              groupId: createdGroup.id,
              userId: data.membership.getEntityId(),
              createdAt: data.membership.createdAt,
              updatedAt: data.membership.updatedAt
            }
          })

          // 3. Update user with all data using shared function
          const updatedUser = await persistExistingUserRaceConditionFree(this.dbClient.cx, {
            organizationId: context.organizationId,
            userId: data.user.id,
            userOcc: data.userOcc,
            displayName: data.user.displayName,
            roles: data.user.roles,
            createdAt: data.user.createdAt,
            updatedAt: data.user.updatedAt
          })

          return E.map(() => createdGroup)(updatedUser)
        },
        error => {
          if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "groups_organization_name_unique"))
            return "group_already_exists"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user")) return "user_not_found"

          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)) return "concurrency_error" as const

          Logger.error("Error while creating group. Unknown error", error)
          return "unknown_error"
        }
      )
  }

  getGroupById(
    context: TenantContext,
    data: GetGroupByIdRepo
  ): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "id", identifier: data.groupId}
    return this.getGroup(context, {identifier})
  }

  getGroupByName(
    context: TenantContext,
    data: GetGroupByNameRepo
  ): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    const identifier: Identifier = {type: "name", identifier: data.groupName}
    return this.getGroup(context, {identifier})
  }

  getGroupIdByName(context: TenantContext, groupName: string): TaskEither<GetGroupRepoError, string> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.group.findUnique({
            where: {organizationId_name: {organizationId: context.organizationId, name: groupName}},
            select: {id: true}
          }),
        error => {
          Logger.error("Error while retrieving group ID by name. Unknown error", error)
          return "unknown_error" as const
        }
      ),
      TE.chainW(result => {
        if (result === null) return TE.left("group_not_found" as const)
        return TE.right(result.id)
      })
    )
  }

  getGroupsByIds(
    context: TenantContext,
    groupIds: string[]
  ): TaskEither<"unknown_error", {id: string; name: string}[]> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.group.findMany({
            where: {
              organizationId: context.organizationId,
              id: {
                in: groupIds
              }
            },
            select: {
              id: true,
              name: true
            }
          }),
        error => {
          Logger.error("Error while fetching groups by ids. Unknown error", error)
          return "unknown_error" as const
        }
      ),
      TE.map(groups => groups.map(g => ({id: g.id, name: g.name})))
    )
  }

  getGroupsByUserId(context: TenantContext, userId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      userId,
      TE.right,
      TE.chainW(this.getGroupsByUserIdTask(context)),
      TE.chainEitherKW(groups =>
        pipe(groups, RA.traverse(E.Applicative)(mapToDomainVersionedGroupWithEntities), E.map(RA.toArray))
      )
    )
  }

  private getGroupsByUserIdTask(
    context: TenantContext
  ): (userId: string) => TaskEither<GetGroupRepoError, PrismaGroupWithCount[]> {
    return userId =>
      fromPromise(
        () =>
          this.dbClient.cx.group.findMany({
            where: {
              organizationId: context.organizationId,
              groupMemberships: {
                some: {
                  organizationId: context.organizationId,
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
      )
  }

  getGroupsByAgentId(context: TenantContext, agentId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      agentId,
      TE.right,
      TE.chainW(this.getGroupsByAgentIdTask(context)),
      TE.chainEitherKW(groups =>
        pipe(groups, RA.traverse(E.Applicative)(mapToDomainVersionedGroupWithEntities), E.map(RA.toArray))
      )
    )
  }

  countGroups(context: TenantContext): TaskEither<UnknownError, number> {
    return fromPromise(
      () => this.dbClient.cx.group.count({where: {organizationId: context.organizationId}}),
      error => {
        Logger.error("Error counting groups", error)
        return "unknown_error"
      }
    )
  }

  private getGroupsByAgentIdTask(
    context: TenantContext
  ): (agentId: string) => TaskEither<GetGroupRepoError, PrismaGroupWithCount[]> {
    return agentId =>
      fromPromise(
        () =>
          this.dbClient.cx.group.findMany({
            where: {
              organizationId: context.organizationId,
              agentGroupMemberships: {
                some: {
                  organizationId: context.organizationId,
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
      )
  }

  private getGroup(
    context: TenantContext,
    request: GetObjectTaskRequest
  ): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getObjectTask(context)),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedGroupWithEntities)
    )
  }

  listGroups(context: TenantContext, data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult> {
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
      TE.chainW(this.getObjectsTask(context)),
      TE.chainEitherKW(([groups, total]) =>
        pipe(
          groups,
          RA.traverse(E.Applicative)(mapToDomainVersionedGroupWithEntities),
          E.map(groups => ({groups: RA.toArray(groups), total, page, limit}))
        )
      )
    )
  }

  private buildWhereClauseGetObjectTask(
    context: TenantContext,
    request: GetObjectTaskRequest
  ): Prisma.GroupWhereUniqueInput {
    return request.identifier.type === "id"
      ? {organizationId_id: {organizationId: context.organizationId, id: request.identifier.identifier}}
      : {organizationId_name: {organizationId: context.organizationId, name: request.identifier.identifier}}
  }

  private getObjectTask(
    context: TenantContext
  ): (request: GetObjectTaskRequest) => TaskEither<GetGroupRepoError, PrismaGroupWithCount | null> {
    // Wrap in a lambda to preserve the "this" context
    return request =>
      fromPromise(
        () =>
          this.dbClient.cx.group.findUnique({
            where: this.buildWhereClauseGetObjectTask(context, request),
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
      )
  }

  private getObjectsTask(
    context: TenantContext
  ): (options: ListOptions) => TaskEither<ListGroupsRepoError, [PrismaGroupWithCount[], number]> {
    // Wrap in a lambda to preserve the "this" context
    return options =>
      fromPromise(
        async (): Promise<[PrismaGroupWithCount[], number]> => {
          const whereClause: Prisma.GroupWhereInput = this.buildWhereCloseForListingGroups(context, options.filter)

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
          return [resolvedData, resolvedStats]
        },
        error => {
          Logger.error("Error while retrieving groups. Unknown error", error)
          return "unknown_error" as const
        }
      )
  }

  private buildWhereCloseForListingGroups(context: TenantContext, filter: ListGroupsFilter): Prisma.GroupWhereInput {
    const baseWhere: Prisma.GroupWhereInput = {
      organizationId: context.organizationId,
      ...(filter.search ? {name: {contains: filter.search, mode: "insensitive"}} : {})
    }

    switch (filter.type) {
      case "all":
        return baseWhere
      case "direct_member":
        return {
          ...baseWhere,
          groupMemberships: {
            some: {
              organizationId: context.organizationId,
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

interface Identifier {
  type: "id" | "name"
  identifier: string
}
interface ListOptions {
  take: number
  skip: number
  filter: ListGroupsFilter
}
type PrismaGroupWithCount = PrismaGroup & {
  readonly _count: {readonly groupMemberships: number; readonly agentGroupMemberships: number}
}

function mapToDomainVersionedGroupWithEntities(
  record: PrismaGroupWithCount
): E.Either<GroupValidationError, Versioned<GroupWithEntitiesCount>> {
  return GroupFactory.validate({
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    entitiesCount: record._count.groupMemberships + record._count.agentGroupMemberships,
    occ: record.occ
  })
}
