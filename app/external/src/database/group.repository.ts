import {Injectable, Logger} from "@nestjs/common"
import {Group, GroupFactory, GroupWithEntitiesCount, TenantContext, Versioned} from "@domain"
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
import {Group as PrismaGroup, Prisma} from "@prisma/client"
import * as E from "fp-ts/Either"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {GroupTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {mapRolesToPrisma} from "./shared"
import {chainNullableToLeft} from "./utils"

type GroupRecord = PrismaGroup & {
  readonly _count: {readonly groupMemberships: number; readonly agentGroupMemberships: number}
}
@Injectable()
export class GroupDbRepository implements GroupRepository {
  constructor(private readonly dbClient: GroupTenantClient) {}

  createGroupWithMembershipAndUpdateUser(
    context: TenantContext,
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TE.TaskEither<CreateGroupRepoError, Group> {
    return pipe(
      TE.tryCatch(
        async () => {
          if (
            context.organizationId !== data.group.organizationId ||
            context.organizationId !== data.user.organizationId
          )
            throw new GroupNotFoundError()
          const group = await this.dbClient.cx.group.create({
            data: {
              id: data.group.id,
              organizationId: context.organizationId,
              name: data.group.name,
              description: data.group.description,
              createdAt: data.group.createdAt,
              updatedAt: data.group.updatedAt,
              occ: 0n
            },
            include: countInclude
          })
          await this.dbClient.cx.groupMembership.create({
            data: {
              organizationId: context.organizationId,
              groupId: group.id,
              userId: data.membership.getEntityId(),
              createdAt: data.membership.createdAt,
              updatedAt: data.membership.updatedAt
            }
          })
          await this.dbClient.cx.user.update({
            where: {id: data.user.id, organizationId: context.organizationId, occ: data.userOcc},
            data: {
              displayName: data.user.displayName,
              roles: mapRolesToPrisma(data.user.roles),
              updatedAt: new Date(),
              occ: {increment: 1}
            }
          })
          return group
        },
        error => this.mapCreateError(error)
      ),
      TE.chainEitherKW(mapGroup)
    )
  }

  getGroupById(
    context: TenantContext,
    data: GetGroupByIdRepo
  ): TE.TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    return this.get({organizationId_id: {organizationId: context.organizationId, id: data.groupId}})
  }

  getGroupByName(
    context: TenantContext,
    data: GetGroupByNameRepo
  ): TE.TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    return this.get({organizationId_name: {organizationId: context.organizationId, name: data.groupName}})
  }

  getGroupIdByName(context: TenantContext, groupName: string): TE.TaskEither<GetGroupRepoError, string> {
    return pipe(
      this.getGroupByName(context, {groupName}),
      TE.map(group => group.id)
    )
  }

  getGroupsByIds(
    context: TenantContext,
    groupIds: string[]
  ): TE.TaskEither<"unknown_error", {id: string; name: string}[]> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.group.findMany({
          where: {organizationId: context.organizationId, id: {in: groupIds}},
          select: {id: true, name: true}
        }),
      error => this.mapUnknown(error, "get groups by ids")
    )
  }

  getGroupsByUserId(context: TenantContext, userId: string): TE.TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      this.findMany(context, {groupMemberships: {some: {organizationId: context.organizationId, userId}}}),
      TE.chainEitherKW(mapGroups)
    )
  }

  getGroupsByAgentId(context: TenantContext, agentId: string): TE.TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      this.findMany(context, {agentGroupMemberships: {some: {organizationId: context.organizationId, agentId}}}),
      TE.chainEitherKW(mapGroups)
    )
  }

  countGroups(context: TenantContext): TE.TaskEither<"unknown_error", number> {
    return TE.tryCatch(
      () => this.dbClient.cx.group.count({where: {organizationId: context.organizationId}}),
      error => this.mapUnknown(error, "count groups")
    )
  }

  listGroups(context: TenantContext, data: ListGroupsRepo): TE.TaskEither<ListGroupsRepoError, ListGroupsResult> {
    if (data.page < 1) return TE.left("invalid_page")
    if (data.limit < 1) return TE.left("invalid_limit")
    const membership =
      data.filter.type === "direct_member"
        ? {groupMemberships: {some: {organizationId: context.organizationId, userId: data.filter.requestor.id}}}
        : {}
    const search = data.filter.search ? {name: {contains: data.filter.search, mode: "insensitive" as const}} : {}
    const where = {organizationId: context.organizationId, ...membership, ...search}
    return pipe(
      TE.tryCatch(
        async () => {
          const [groups, total] = await Promise.all([
            this.dbClient.cx.group.findMany({
              where,
              orderBy: {createdAt: "asc"},
              skip: (data.page - 1) * data.limit,
              take: data.limit,
              include: countInclude
            }),
            this.dbClient.cx.group.count({where})
          ])
          return {groups, total}
        },
        error => this.mapUnknown(error, "list groups")
      ),
      TE.chainEitherKW(({groups, total}): E.Either<"unknown_error", ListGroupsResult> => {
        const mapped = mapGroups(groups)
        return isLeft(mapped) ? mapped : E.right({groups: mapped.right, total, page: data.page, limit: data.limit})
      })
    )
  }

  private get(
    where: Prisma.GroupWhereUniqueInput
  ): TE.TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>> {
    return pipe(
      TE.tryCatch(
        () => this.dbClient.cx.group.findUnique({where, include: countInclude}),
        error => this.mapGetError(error)
      ),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapGroup)
    )
  }

  private findMany(
    context: TenantContext,
    where: Prisma.GroupWhereInput
  ): TE.TaskEither<GetGroupRepoError, GroupRecord[]> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.group.findMany({
          where: {organizationId: context.organizationId, ...where},
          include: countInclude
        }),
      error => this.mapGetError(error)
    )
  }

  private mapCreateError(error: unknown): CreateGroupRepoError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "name"], "groups_organization_name_unique"))
      return "group_already_exists"
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) return "concurrency_error"
    Logger.error("Group repository create failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
  private mapGetError(error: unknown): GetGroupRepoError {
    return this.mapUnknown(error, "group lookup")
  }
  private mapUnknown(error: unknown, operation: string): "unknown_error" {
    Logger.error(`Group repository ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

const countInclude = {_count: {select: {groupMemberships: true, agentGroupMemberships: true}}} as const
function mapGroup(record: GroupRecord): E.Either<"unknown_error", Versioned<GroupWithEntitiesCount>> {
  return E.mapLeft(() => "unknown_error" as const)(
    GroupFactory.validate({
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      description: record.description,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      entitiesCount: record._count.groupMemberships + record._count.agentGroupMemberships,
      occ: record.occ
    })
  )
}
function mapUnversionedGroup(record: GroupRecord): E.Either<"unknown_error", GroupWithEntitiesCount> {
  return E.mapLeft(() => "unknown_error" as const)(
    GroupFactory.validate({
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      description: record.description,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      entitiesCount: record._count.groupMemberships + record._count.agentGroupMemberships
    })
  )
}
function mapGroups(records: ReadonlyArray<GroupRecord>): E.Either<"unknown_error", GroupWithEntitiesCount[]> {
  const groups: GroupWithEntitiesCount[] = []
  for (const record of records) {
    const mapped = mapUnversionedGroup(record)
    if (isLeft(mapped)) return mapped
    groups.push(mapped.right)
  }
  return E.right(groups)
}
class GroupNotFoundError extends Error {}
