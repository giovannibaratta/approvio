import {pipe} from "fp-ts/function"
import {chainNullableToLeft} from "./utils"
import {fromPromise, fromEitherPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {
  AgentValidationError,
  GroupValidationError,
  UserValidationError,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  GroupFactory,
  Membership,
  MembershipFactory,
  MembershipWithGroupRef,
  TenantContext,
  UserFactory,
  createAgentMembershipEntity,
  createUserMembershipEntity
} from "@domain"
import {
  AddMembershipRepoRequest,
  AddMembershipResult,
  GetGroupMembershipResult,
  GetGroupRepoError,
  GetGroupWithMembershipRepo,
  GroupMembershipRepository,
  MembershipAddError,
  MembershipRemoveError,
  RemoveMembershipRepoRequest,
  RemoveMembershipResult,
  UnknownError,
  AgentKeyDecodeError,
  RepositoryDependencyError
} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {Prisma} from "@prisma/client"
import {GroupMembershipTenantClient} from "./tenant-database-clients"
import {isPrismaUniqueConstraintError, isPrismaForeignKeyConstraintError, isPrismaRecordNotFoundError} from "./errors"
import {mapAgentToDomain} from "./shared"

@Injectable()
export class GroupMembershipDbRepository implements GroupMembershipRepository {
  constructor(private readonly dbClient: GroupMembershipTenantClient) {}

  getGroupWithMembershipById(
    context: TenantContext,
    data: GetGroupWithMembershipRepo
  ): TE.TaskEither<
    GetGroupRepoError | UserValidationError | AgentValidationError | MembershipValidationError | AgentKeyDecodeError,
    GetGroupMembershipResult
  > {
    return pipe(
      this.getObjectTask(context, data),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  addMembershipsToGroup(
    context: TenantContext,
    request: AddMembershipRepoRequest
  ): TE.TaskEither<MembershipAddError, AddMembershipResult> {
    return pipe(this.createMembershipTask(context, request), TE.chainEitherKW(mapToVersionedDomainWithMembership))
  }

  removeMembershipFromGroup(
    context: TenantContext,
    request: RemoveMembershipRepoRequest
  ): TE.TaskEither<MembershipRemoveError, RemoveMembershipResult> {
    return pipe(this.deleteMembershipTask(context, request), TE.chainEitherKW(mapToVersionedDomainWithMembership))
  }

  removeAllGroupMemberships(context: TenantContext, userId: string): TE.TaskEither<RepositoryDependencyError, void> {
    return fromPromise(
      async () => {
        await this.dbClient.cx.groupMembership.deleteMany({where: {organizationId: context.organizationId, userId}})
      },
      () => "repository_dependency_error" as const
    )
  }

  getUserMembershipsByUserId(
    context: TenantContext,
    userId: string
  ): TE.TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  > {
    return pipe(
      this.getUserMembershipsByUserIdTask(context, userId),
      TE.chainEitherKW(mapToDomainMembershipWithGroupRefs)
    )
  }

  getAgentMembershipsByAgentId(
    context: TenantContext,
    agentId: string
  ): TE.TaskEither<
    MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  > {
    return pipe(
      this.getAgentMembershipsByAgentIdTask(context, agentId),
      TE.chainEitherKW(mapToDomainAgentMembershipWithGroupRefs)
    )
  }

  countUserMembersByGroupId(context: TenantContext, groupId: string): TE.TaskEither<UnknownError, number> {
    return fromPromise(
      () => this.dbClient.cx.groupMembership.count({where: {organizationId: context.organizationId, groupId}}),
      error => this.mapUnknownError(error, "count users")
    )
  }

  countAgentMembersByGroupId(context: TenantContext, groupId: string): TE.TaskEither<UnknownError, number> {
    return fromPromise(
      () => this.dbClient.cx.agentGroupMembership.count({where: {organizationId: context.organizationId, groupId}}),
      error => this.mapUnknownError(error, "count agents")
    )
  }

  private getObjectTask(
    context: TenantContext,
    data: GetGroupWithMembershipRepo
  ): TE.TaskEither<UnknownError, GroupWithMemberships | null> {
    return fromPromise(
      () =>
        this.dbClient.cx.group.findUnique({
          where: {
            organizationId_id: {organizationId: context.organizationId, id: data.groupId},
            groupMemberships: data.onlyIfMember ? {some: {userId: data.onlyIfMember.userId}} : undefined
          },
          include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
        }),
      error => this.mapUnknownError(error, "get")
    )
  }

  private createMembershipTask(
    context: TenantContext,
    request: AddMembershipRepoRequest
  ): TE.TaskEither<MembershipAddError, GroupWithMemberships> {
    return fromEitherPromise(
      () => this.createMembershipWithOccCheck(context, request),
      error => this.mapAddError(error)
    )
  }

  private deleteMembershipTask(
    context: TenantContext,
    request: RemoveMembershipRepoRequest
  ): TE.TaskEither<MembershipRemoveError, GroupWithMemberships> {
    return fromEitherPromise(
      () => this.deleteMembershipAndUpdateGroup(context, request),
      error =>
        isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)
          ? "group_not_found"
          : this.mapUnknownError(error, "remove")
    )
  }

  private async createMembershipWithOccCheck(
    context: TenantContext,
    request: AddMembershipRepoRequest
  ): Promise<E.Either<MembershipAddError, GroupWithMemberships>> {
    const {userMemberships, agentMemberships} = request.memberships.reduce<{
      userMemberships: Prisma.GroupMembershipCreateManyInput[]
      agentMemberships: Prisma.AgentGroupMembershipCreateManyInput[]
    }>(
      (acc, m) => {
        const membershipData = {
          organizationId: context.organizationId,
          groupId: request.group.id,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }

        if (m.getEntityType() === "user") acc.userMemberships.push({...membershipData, userId: m.getEntityId()})
        else acc.agentMemberships.push({...membershipData, agentId: m.getEntityId()})

        return acc
      },
      {userMemberships: [], agentMemberships: []}
    )

    if (userMemberships.length > 0) await this.dbClient.cx.groupMembership.createMany({data: userMemberships})
    if (agentMemberships.length > 0) await this.dbClient.cx.agentGroupMembership.createMany({data: agentMemberships})

    // We do not update the parent Group's updatedAt or occ here to prevent unnecessary
    // concurrent modification conflicts, keeping membership modifications and quota checks optimistic.
    // If a stricter policy is needed in the future, we can lock and increment the parent's occ version.
    const result = await this.dbClient.cx.group.findUnique({
      where: {organizationId_id: {organizationId: context.organizationId, id: request.group.id}},
      include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
    })
    if (!result) return E.left("concurrent_modification_error" as const)
    return E.right(result)
  }

  private async deleteMembershipAndUpdateGroup(
    context: TenantContext,
    request: RemoveMembershipRepoRequest
  ): Promise<E.Either<UnknownError, GroupWithMemberships>> {
    const {userIds, agentIds} = request.entityReferences.reduce<{userIds: string[]; agentIds: string[]}>(
      (acc, ref) => {
        if (ref.entityType === "user") acc.userIds.push(ref.entityId)
        else acc.agentIds.push(ref.entityId)
        return acc
      },
      {userIds: [], agentIds: []}
    )

    if (userIds.length > 0)
      await this.dbClient.cx.groupMembership.deleteMany({
        where: {organizationId: context.organizationId, groupId: request.groupId, userId: {in: userIds}}
      })
    if (agentIds.length > 0)
      await this.dbClient.cx.agentGroupMembership.deleteMany({
        where: {organizationId: context.organizationId, groupId: request.groupId, agentId: {in: agentIds}}
      })

    // We do not update parent Group's updatedAt/occ here to maintain parity with the addition flow
    const group = await this.dbClient.cx.group.findUnique({
      where: {organizationId_id: {organizationId: context.organizationId, id: request.groupId}},
      include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
    })
    if (!group) return E.left("unknown_error" as const)
    return E.right(group)
  }

  private getUserMembershipsByUserIdTask(
    context: TenantContext,
    userId: string
  ): TE.TaskEither<UnknownError, ReadonlyArray<UserMembershipRow>> {
    return fromPromise(
      () =>
        this.dbClient.cx.groupMembership.findMany({
          where: {organizationId: context.organizationId, userId},
          include: {users: true}
        }),
      error => this.mapUnknownError(error, "get user memberships")
    )
  }

  private getAgentMembershipsByAgentIdTask(
    context: TenantContext,
    agentId: string
  ): TE.TaskEither<UnknownError, ReadonlyArray<AgentMembershipRow>> {
    return fromPromise(
      () =>
        this.dbClient.cx.agentGroupMembership.findMany({
          where: {organizationId: context.organizationId, agentId},
          include: {agents: true}
        }),
      error => this.mapUnknownError(error, "get agent memberships")
    )
  }

  private mapAddError(error: unknown): MembershipAddError {
    if (
      isPrismaForeignKeyConstraintError(error, "fk_group_memberships_group") ||
      isPrismaForeignKeyConstraintError(error, "fk_agent_group_memberships_group")
    )
      return "concurrent_modification_error"
    if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user")) return "membership_user_not_found"
    if (isPrismaForeignKeyConstraintError(error, "fk_agent_group_memberships_agent"))
      return "membership_agent_not_found"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "group_id", "user_id"]))
      return "membership_entity_already_in_group"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "group_id", "agent_id"]))
      return "membership_entity_already_in_group"
    return this.mapUnknownError(error, "add")
  }

  private mapUnknownError(error: unknown, operation: string): UnknownError {
    Logger.error(`Group membership ${operation} failed`, error)
    return "unknown_error"
  }

  private static readonly GROUP_WITH_MEMBERSHIPS_INCLUDE = {
    groupMemberships: {include: {users: true}},
    agentGroupMemberships: {include: {agents: true}}
  } as const
}

type GroupWithMemberships = Prisma.GroupGetPayload<{
  include: (typeof GroupMembershipDbRepository)["GROUP_WITH_MEMBERSHIPS_INCLUDE"]
}>
type UserMembershipRow = Prisma.GroupMembershipGetPayload<{include: {users: true}}>
type AgentMembershipRow = Prisma.AgentGroupMembershipGetPayload<{include: {agents: true}}>

function mapToVersionedDomainWithMembership(
  group: GroupWithMemberships
): E.Either<
  GroupValidationError | UserValidationError | MembershipValidationError | AgentKeyDecodeError | AgentValidationError,
  GetGroupMembershipResult
> {
  return pipe(
    GroupFactory.validate({
      id: group.id,
      organizationId: group.organizationId,
      name: group.name,
      description: group.description,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    }),
    E.chainW(validated =>
      pipe(
        E.sequenceArray([
          ...group.groupMemberships.map(mapUserMembershipToDomain),
          ...group.agentGroupMemberships.map(mapAgentMembershipToDomain)
        ]),
        E.map(memberships => ({group: {...validated, occ: group.occ}, memberships: [...memberships]}))
      )
    )
  )
}

function mapUserMembershipToDomain(
  row: UserMembershipRow
): E.Either<MembershipValidationError | UserValidationError, Membership> {
  return pipe(
    UserFactory.validate({
      id: row.users.id,
      organizationId: row.users.organizationId,
      accountId: row.users.platformAccountId,
      displayName: row.users.displayName,
      status: row.users.status,
      orgRole: row.users.orgRole,
      roles: row.users.roles,
      createdAt: row.users.createdAt,
      updatedAt: row.users.updatedAt
    }),
    E.chainW(user =>
      MembershipFactory.validate({
        organizationId: row.organizationId,
        entity: createUserMembershipEntity(user),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
    )
  )
}

function mapAgentMembershipToDomain(
  row: AgentMembershipRow
): E.Either<MembershipValidationError | AgentKeyDecodeError | AgentValidationError, Membership> {
  return pipe(
    mapAgentToDomain(row.agents),
    E.chainW(agent =>
      MembershipFactory.validate({
        organizationId: row.organizationId,
        entity: createAgentMembershipEntity(agent),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
    )
  )
}

function mapToDomainMembershipWithGroupRefs(
  rows: ReadonlyArray<UserMembershipRow>
): E.Either<MembershipValidationErrorWithGroupRef | UserValidationError, ReadonlyArray<MembershipWithGroupRef>> {
  return E.sequenceArray(rows.map(mapToDomainMembershipWithGroupRef))
}

function mapToDomainMembershipWithGroupRef(
  row: UserMembershipRow
): E.Either<MembershipValidationErrorWithGroupRef | UserValidationError, MembershipWithGroupRef> {
  return pipe(
    mapUserMembershipToDomain(row),
    E.chainW(membership => MembershipFactory.validateWithGroupRef({...membership, groupId: row.groupId}))
  )
}

function mapToDomainAgentMembershipWithGroupRefs(
  rows: ReadonlyArray<AgentMembershipRow>
): E.Either<
  MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError,
  ReadonlyArray<MembershipWithGroupRef>
> {
  return E.sequenceArray(rows.map(mapToDomainAgentMembershipWithGroupRef))
}

function mapToDomainAgentMembershipWithGroupRef(
  row: AgentMembershipRow
): E.Either<
  MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError,
  MembershipWithGroupRef
> {
  return pipe(
    mapAgentMembershipToDomain(row),
    E.chainW(membership => MembershipFactory.validateWithGroupRef({...membership, groupId: row.groupId}))
  )
}
