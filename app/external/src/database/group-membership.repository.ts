import {
  GroupValidationError,
  Membership,
  MembershipFactory,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef,
  UserValidationError,
  createUserMembershipEntity,
  createAgentMembershipEntity,
  AgentValidationError
} from "@domain"
import {
  isPrismaForeignKeyConstraintError,
  isPrismaRecordNotFoundError,
  isPrismaUniqueConstraintError
} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {
  Prisma,
  Group as PrismaGroup,
  GroupMembership as PrismaGroupMembership,
  Agent as PrismaAgent,
  AgentGroupMembership as PrismaAgentGroupMembership
} from "@prisma/client"
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
  AgentKeyDecodeError
} from "@services"
import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedGroup, mapUserToDomain, mapAgentToDomain} from "./shared"
import {chainNullableToLeft} from "./utils"
import {PrismaUserWithOrgAdmin} from "./user.repository"

type GroupWithMemberships = PrismaGroup & {
  groupMemberships: (PrismaGroupMembership & {users: PrismaUserWithOrgAdmin})[]
  agentGroupMemberships: (PrismaAgentGroupMembership & {agents: PrismaAgent})[]
}

@Injectable()
export class GroupMembershipDbRepository implements GroupMembershipRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  getGroupWithMembershipById(
    data: GetGroupWithMembershipRepo
  ): TaskEither<
    GetGroupRepoError | UserValidationError | AgentValidationError | MembershipValidationError | AgentKeyDecodeError,
    GetGroupMembershipResult
  > {
    return pipe(
      data,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("group_not_found" as const),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  addMembershipsToGroup(request: AddMembershipRepoRequest): TaskEither<MembershipAddError, AddMembershipResult> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.createMembershipTask()),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  removeMembershipFromGroup(
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.deleteMembershipTask()),
      TE.chainEitherKW(mapToVersionedDomainWithMembership)
    )
  }

  getUserMembershipsByUserId(
    userId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  > {
    return pipe(
      userId,
      TE.right,
      TE.chainW(this.getUserMembershipsByUserIdTask()),
      TE.chainEitherKW(mapToDomainMembershipWithGroupRefs)
    )
  }

  getAgentMembershipsByAgentId(
    agentId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  > {
    return pipe(
      agentId,
      TE.right,
      TE.chainW(this.getAgentMembershipsByAgentIdTask()),
      TE.chainEitherKW(mapToDomainAgentMembershipWithGroupRefs)
    )
  }

  countUserMembersByGroupId(groupId: string): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () => this.dbClient.cx.groupMembership.count({where: {groupId}}),
      error => {
        Logger.error("Error counting user memberships", error)
        return "unknown_error"
      }
    )
  }

  countAgentMembersByGroupId(groupId: string): TaskEither<UnknownError, number> {
    return TE.tryCatch(
      () => this.dbClient.cx.agentGroupMembership.count({where: {groupId}}),
      error => {
        Logger.error("Error counting agent memberships", error)
        return "unknown_error"
      }
    )
  }

  private getObjectTask(): (
    data: GetGroupWithMembershipRepo
  ) => TaskEither<GetGroupRepoError, GroupWithMemberships | null> {
    // Wrap in a lambda to preserve the "this" context
    return data =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.group.findUnique({
            where: this.buildWhereClauseGetObjectTask(data),
            include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
          }),
        error => {
          Logger.error("Error while retrieving group. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private buildWhereClauseGetObjectTask(data: GetGroupWithMembershipRepo): Prisma.GroupWhereUniqueInput {
    let groupMembershipClause: Prisma.GroupWhereUniqueInput["groupMemberships"] = undefined

    if (data.onlyIfMember) {
      groupMembershipClause = {
        some: {
          userId: data.onlyIfMember.userId
        }
      }
    }

    return {
      id: data.groupId,
      groupMemberships: groupMembershipClause
    }
  }

  private createMembershipTask(): (
    request: AddMembershipRepoRequest
  ) => TaskEither<MembershipAddError, GroupWithMemberships> {
    return data =>
      TE.tryCatchK(
        () => this.createMembershipWithOccCheck(data),
        error => {
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_group"))
            return "concurrent_modification_error"
          if (isPrismaForeignKeyConstraintError(error, "fk_agent_group_memberships_group"))
            return "concurrent_modification_error"
          if (isPrismaForeignKeyConstraintError(error, "fk_group_memberships_user")) return "membership_user_not_found"
          if (isPrismaForeignKeyConstraintError(error, "fk_agent_group_memberships_agent"))
            return "membership_agent_not_found"
          if (isPrismaUniqueConstraintError(error, ["group_id", "user_id"])) return "membership_entity_already_in_group"
          if (isPrismaUniqueConstraintError(error, ["group_id", "agent_id"]))
            return "membership_entity_already_in_group"
          if (error instanceof ConcurrentModificationError) return "concurrent_modification_error"
          return "unknown_error"
        }
      )()
  }

  private deleteMembershipTask(): (
    request: RemoveMembershipRepoRequest
  ) => TaskEither<MembershipRemoveError, GroupWithMemberships> {
    return data =>
      TE.tryCatchK(
        () => this.deleteMembershipAndUpdateGroup(data),
        error => {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)) return "group_not_found"
          return "unknown_error"
        }
      )()
  }

  private async createMembershipWithOccCheck(data: AddMembershipRepoRequest): Promise<GroupWithMemberships> {
    // Compute data blocks outside transaction for better performance
    const {userMemberships, agentMemberships} = data.memberships.reduce(
      (acc, m) => {
        const membershipData = {
          groupId: data.group.id,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }

        if (m.getEntityType() === "user") acc.userMemberships.push({...membershipData, userId: m.getEntityId()})
        else acc.agentMemberships.push({...membershipData, agentId: m.getEntityId()})

        return acc
      },
      {
        userMemberships: [] as Array<Prisma.GroupMembershipCreateManyInput>,
        agentMemberships: [] as Array<Prisma.AgentGroupMembershipCreateManyInput>
      }
    )

    return this.dbClient.transactional(async tx => {
      if (userMemberships.length > 0) await tx.groupMembership.createMany({data: userMemberships})
      if (agentMemberships.length > 0) await tx.agentGroupMembership.createMany({data: agentMemberships})

      // We do not update the parent Group's updatedAt or occ here to prevent unnecessary
      // concurrent modification conflicts, keeping membership modifications and quota checks optimistic.
      // If a stricter policy is needed in the future, we can lock and increment the parent's occ version.
      const updatedGroup = await tx.group.findUnique({
        where: {id: data.group.id},
        include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
      })

      if (!updatedGroup) throw new ConcurrentModificationError(`Group not found: ${data.group.id}`)

      return updatedGroup
    })
  }

  private async deleteMembershipAndUpdateGroup(data: RemoveMembershipRepoRequest): Promise<GroupWithMemberships> {
    // Compute ID arrays outside transaction for better performance - single iteration using fold
    const {userIds, agentIds} = data.entityReferences.reduce(
      (acc, ref) => {
        if (ref.entityType === "user") acc.userIds.push(ref.entityId)
        else acc.agentIds.push(ref.entityId)
        return acc
      },
      {userIds: [] as string[], agentIds: [] as string[]}
    )

    return this.dbClient.transactional(async tx => {
      if (userIds.length > 0)
        await tx.groupMembership.deleteMany({
          where: {
            groupId: data.groupId,
            userId: {in: userIds}
          }
        })

      if (agentIds.length > 0)
        await tx.agentGroupMembership.deleteMany({
          where: {
            groupId: data.groupId,
            agentId: {in: agentIds}
          }
        })

      // We do not update parent Group's updatedAt/occ here to maintain parity with the addition flow
      const updatedGroup = await tx.group.findUnique({
        where: {id: data.groupId},
        include: GroupMembershipDbRepository.GROUP_WITH_MEMBERSHIPS_INCLUDE
      })

      if (!updatedGroup) throw new Error(`Group not found: ${data.groupId}`)

      return updatedGroup
    })
  }

  private getUserMembershipsByUserIdTask(): (
    userId: string
  ) => TaskEither<UnknownError, ReadonlyArray<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>> {
    return userId =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.groupMembership.findMany({
            where: {userId},
            include: {users: {include: {organizationAdmins: true}}}
          }),
        error => {
          Logger.error("Error while retrieving user memberships. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private getAgentMembershipsByAgentIdTask(): (
    agentId: string
  ) => TaskEither<UnknownError, ReadonlyArray<PrismaAgentGroupMembership & {agents: PrismaAgent}>> {
    return agentId =>
      TE.tryCatchK(
        () =>
          this.dbClient.cx.agentGroupMembership.findMany({
            where: {agentId},
            include: {agents: true}
          }),
        error => {
          Logger.error("Error while retrieving agent memberships. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private static readonly GROUP_WITH_MEMBERSHIPS_INCLUDE = {
    groupMemberships: {
      include: {
        users: {
          include: {
            organizationAdmins: true
          }
        }
      }
    },
    agentGroupMemberships: {
      include: {
        agents: true
      }
    }
  } as const
}

function mapUserMembershipToDomain(
  dbObject: PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}
): Either<MembershipValidationError | UserValidationError, Membership> {
  return pipe(
    E.Do,
    E.bindW("user", () => mapUserToDomain(dbObject.users)),
    E.bindW("data", ({user}) => {
      return E.right({
        entity: createUserMembershipEntity(user),
        createdAt: dbObject.createdAt,
        updatedAt: dbObject.updatedAt
      })
    }),
    E.chainW(({data}) => MembershipFactory.validate(data))
  )
}

function mapAgentMembershipToDomain(
  dbObject: PrismaAgentGroupMembership & {agents: PrismaAgent}
): Either<MembershipValidationError | AgentKeyDecodeError | AgentValidationError, Membership> {
  return pipe(
    E.Do,
    E.bindW("agent", () => mapAgentToDomain(dbObject.agents)),
    E.bindW("data", ({agent}) => {
      return E.right({
        entity: createAgentMembershipEntity(agent),
        createdAt: dbObject.createdAt,
        updatedAt: dbObject.updatedAt
      })
    }),
    E.chainW(({data}) => MembershipFactory.validate(data))
  )
}

function mapToVersionedDomainWithMembership(
  dbObject: GroupWithMemberships
): Either<
  GroupValidationError | UserValidationError | MembershipValidationError | AgentKeyDecodeError | AgentValidationError,
  GetGroupMembershipResult
> {
  return pipe(
    E.Do,
    E.bindW("group", () => mapToDomainVersionedGroup(dbObject)),
    E.bindW("userMemberships", () =>
      pipe(dbObject.groupMemberships, A.traverse(E.Applicative)(mapUserMembershipToDomain))
    ),
    E.bindW("agentMemberships", () =>
      pipe(dbObject.agentGroupMemberships, A.traverse(E.Applicative)(mapAgentMembershipToDomain))
    ),
    E.map(({group, userMemberships, agentMemberships}) => ({
      group,
      memberships: [...userMemberships, ...agentMemberships]
    }))
  )
}

function mapToDomainMembershipWithGroupRefs(
  dbObject: ReadonlyArray<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>
): Either<MembershipValidationErrorWithGroupRef | UserValidationError, ReadonlyArray<MembershipWithGroupRef>> {
  return pipe([...dbObject], A.traverse(E.Applicative)(mapToDomainMembershipWithGroupRef))
}

function mapToDomainMembershipWithGroupRef(
  dbObject: Readonly<PrismaGroupMembership & {users: PrismaUserWithOrgAdmin}>
): Either<MembershipValidationErrorWithGroupRef | UserValidationError, MembershipWithGroupRef> {
  return pipe(
    E.Do,
    E.bindW("membership", () => mapUserMembershipToDomain(dbObject)),
    E.bindW("data", ({membership}) => {
      return E.right({
        ...membership,
        groupId: dbObject.groupId
      })
    }),
    E.chainW(({data}) => MembershipFactory.validateWithGroupRef(data))
  )
}

function mapToDomainAgentMembershipWithGroupRefs(
  dbObject: ReadonlyArray<PrismaAgentGroupMembership & {agents: PrismaAgent}>
): Either<
  MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError,
  ReadonlyArray<MembershipWithGroupRef>
> {
  return pipe([...dbObject], A.traverse(E.Applicative)(mapToDomainAgentMembershipWithGroupRef))
}

function mapToDomainAgentMembershipWithGroupRef(
  dbObject: Readonly<PrismaAgentGroupMembership & {agents: PrismaAgent}>
): Either<MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError, MembershipWithGroupRef> {
  return pipe(
    E.Do,
    E.bindW("membership", () => mapAgentMembershipToDomain(dbObject)),
    E.bindW("data", ({membership}) => {
      return E.right({
        ...membership,
        groupId: dbObject.groupId
      })
    }),
    E.chainW(({data}) => MembershipFactory.validateWithGroupRef(data))
  )
}

class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConcurrentModificationError"
  }
}
