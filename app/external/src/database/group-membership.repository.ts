import {Injectable, Logger} from "@nestjs/common"
import {
  AgentFactory,
  EntityReference,
  GroupFactory,
  Membership,
  MembershipFactory,
  MembershipStatus,
  MembershipWithGroupRef,
  OrgRole,
  TenantContext,
  UserFactory,
  createAgentMembershipEntity,
  createUserMembershipEntity
} from "@domain"
import {
  AddMembershipRepoRequest,
  GetGroupMembershipResult,
  GetGroupWithMembershipRepo,
  GroupMembershipRepository,
  MembershipAddError,
  MembershipRemoveError,
  RemoveMembershipRepoRequest
} from "@services"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {Prisma} from "@prisma/client"
import {GroupMembershipTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

@Injectable()
export class GroupMembershipDbRepository implements GroupMembershipRepository {
  constructor(private readonly dbClient: GroupMembershipTenantClient) {}

  getGroupWithMembershipById(
    context: TenantContext,
    data: GetGroupWithMembershipRepo
  ): TE.TaskEither<"group_not_found" | "unknown_error", GetGroupMembershipResult> {
    return TE.tryCatch(
      async () => {
        const group = await this.dbClient.cx.group.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id: data.groupId}},
          include: groupWithMembershipsInclude
        })
        const onlyIfMember = data.onlyIfMember
        if (
          !group ||
          (onlyIfMember !== false && !group.groupMemberships.some(row => row.userId === onlyIfMember.userId))
        )
          throw new GroupMembershipNotFoundError()
        return toGroupMembershipResult(group)
      },
      error => this.mapGetError(error, "get")
    )
  }

  addMembershipsToGroup(
    context: TenantContext,
    request: AddMembershipRepoRequest
  ): TE.TaskEither<MembershipAddError, GetGroupMembershipResult> {
    return TE.tryCatch(
      async () => {
        if (
          request.group.organizationId !== context.organizationId ||
          request.memberships.some(membership => membership.organizationId !== context.organizationId)
        )
          throw new OrganizationMismatchError()

        const group = await this.dbClient.cx.group.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id: request.group.id}},
          select: {id: true, occ: true}
        })
        // The service has already validated the group and carries its OCC value into this
        // write. A missing parent at this point means it changed concurrently, not that the
        // request failed the normal not-found validation.
        if (!group) throw new ConcurrentModificationError()
        if (group.occ !== request.group.occ) throw new ConcurrentModificationError()

        for (const membership of request.memberships)
          if (membership.getEntityType() === "user")
            await this.dbClient.cx.groupMembership.create({
              data: {
                organizationId: context.organizationId,
                groupId: request.group.id,
                userId: membership.getEntityId(),
                createdAt: membership.createdAt,
                updatedAt: membership.updatedAt
              }
            })
          else
            await this.dbClient.cx.agentGroupMembership.create({
              data: {
                organizationId: context.organizationId,
                groupId: request.group.id,
                agentId: membership.getEntityId(),
                createdAt: membership.createdAt,
                updatedAt: membership.updatedAt
              }
            })

        await this.dbClient.cx.group.update({
          where: {id: request.group.id, organizationId: context.organizationId, occ: request.group.occ},
          data: {occ: {increment: 1}, updatedAt: new Date()}
        })

        const result = await this.dbClient.cx.group.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id: request.group.id}},
          include: groupWithMembershipsInclude
        })
        if (!result) throw new GroupMembershipNotFoundError()
        return toGroupMembershipResult(result)
      },
      error => this.mapAddError(error)
    )
  }

  removeMembershipFromGroup(
    context: TenantContext,
    request: RemoveMembershipRepoRequest
  ): TE.TaskEither<MembershipRemoveError, GetGroupMembershipResult> {
    return TE.tryCatch(
      async () => {
        if (request.entityReferences.some(reference => reference.organizationId !== context.organizationId))
          throw new OrganizationMismatchError()

        for (const reference of request.entityReferences) await this.removeEntity(context, request.groupId, reference)

        const group = await this.dbClient.cx.group.findUnique({
          where: {organizationId_id: {organizationId: context.organizationId, id: request.groupId}},
          include: groupWithMembershipsInclude
        })
        if (!group) throw new GroupMembershipNotFoundError()
        return toGroupMembershipResult(group)
      },
      error => this.mapRemoveError(error)
    )
  }

  getUserMembershipsByUserId(
    context: TenantContext,
    userId: string
  ): TE.TaskEither<"unknown_error", ReadonlyArray<MembershipWithGroupRef>> {
    return TE.tryCatch(
      async () => {
        const rows = await this.dbClient.cx.groupMembership.findMany({
          where: {organizationId: context.organizationId, userId},
          include: {users: true}
        })
        return rows.map(toUserMembershipWithGroupRef)
      },
      error => this.mapUnknownError(error, "get user memberships")
    )
  }

  getAgentMembershipsByAgentId(
    context: TenantContext,
    agentId: string
  ): TE.TaskEither<"unknown_error", ReadonlyArray<MembershipWithGroupRef>> {
    return TE.tryCatch(
      async () => {
        const rows = await this.dbClient.cx.agentGroupMembership.findMany({
          where: {organizationId: context.organizationId, agentId},
          include: {agents: true}
        })
        return rows.map(toAgentMembershipWithGroupRef)
      },
      error => this.mapUnknownError(error, "get agent memberships")
    )
  }

  countUserMembersByGroupId(context: TenantContext, groupId: string): TE.TaskEither<"unknown_error", number> {
    return TE.tryCatch(
      () => this.dbClient.cx.groupMembership.count({where: {organizationId: context.organizationId, groupId}}),
      error => this.mapUnknownError(error, "count users")
    )
  }

  countAgentMembersByGroupId(context: TenantContext, groupId: string): TE.TaskEither<"unknown_error", number> {
    return TE.tryCatch(
      () => this.dbClient.cx.agentGroupMembership.count({where: {organizationId: context.organizationId, groupId}}),
      error => this.mapUnknownError(error, "count agents")
    )
  }

  private async removeEntity(context: TenantContext, groupId: string, reference: EntityReference): Promise<void> {
    const where = {organizationId: context.organizationId, groupId}
    const result =
      reference.entityType === "user"
        ? await this.dbClient.cx.groupMembership.deleteMany({where: {...where, userId: reference.entityId}})
        : await this.dbClient.cx.agentGroupMembership.deleteMany({where: {...where, agentId: reference.entityId}})
    if (result.count !== 1) throw new GroupMembershipNotFoundError()
  }

  private mapGetError(error: unknown, operation: string): "group_not_found" | "unknown_error" {
    if (error instanceof GroupMembershipNotFoundError) return "group_not_found"
    return this.mapUnknownError(error, operation)
  }

  private mapAddError(error: unknown): MembershipAddError {
    if (error instanceof OrganizationMismatchError) return "membership_organization_mismatch"
    if (error instanceof GroupMembershipNotFoundError) return "membership_group_not_found"
    if (error instanceof ConcurrentModificationError) return "concurrent_modification_error"
    if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Group)) return "concurrent_modification_error"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "group_id", "user_id"]))
      return "membership_entity_already_in_group"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "group_id", "agent_id"]))
      return "membership_entity_already_in_group"
    return this.mapUnknownError(error, "add")
  }

  private mapRemoveError(error: unknown): MembershipRemoveError {
    if (error instanceof OrganizationMismatchError) return "membership_organization_mismatch"
    if (error instanceof GroupMembershipNotFoundError) return "membership_not_found"
    return this.mapUnknownError(error, "remove")
  }

  private mapUnknownError(error: unknown, operation: string): "unknown_error" {
    Logger.error(`Group membership ${operation} failed`, error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

const groupWithMembershipsInclude = {
  groupMemberships: {include: {users: true}},
  agentGroupMemberships: {include: {agents: true}}
} as const

type GroupWithMemberships = Prisma.GroupGetPayload<{include: typeof groupWithMembershipsInclude}>
type UserMembershipRow = Prisma.GroupMembershipGetPayload<{include: {users: true}}>
type AgentMembershipRow = Prisma.AgentGroupMembershipGetPayload<{include: {agents: true}}>

function toGroupMembershipResult(group: GroupWithMemberships): GetGroupMembershipResult {
  const validatedGroup = GroupFactory.validate({
    id: group.id,
    organizationId: group.organizationId,
    name: group.name,
    description: group.description,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt
  })
  if (E.isLeft(validatedGroup)) throw new InvalidGroupMembershipRecordError()
  return {
    group: {...validatedGroup.right, occ: group.occ},
    memberships: [
      ...group.groupMemberships.map(toUserMembership),
      ...group.agentGroupMemberships.map(toAgentMembership)
    ]
  }
}

function toUserMembership(row: UserMembershipRow): Membership {
  const user = UserFactory.validate({
    id: row.users.id,
    organizationId: row.users.organizationId,
    accountId: row.users.platformAccountId,
    displayName: row.users.displayName,
    status: toMembershipStatus(row.users.status),
    orgRole: toOrgRole(row.users.orgRole),
    roles: row.users.roles,
    createdAt: row.users.createdAt,
    updatedAt: row.users.updatedAt
  })
  if (E.isLeft(user)) throw new InvalidGroupMembershipRecordError()
  const membership = MembershipFactory.validate({
    organizationId: row.organizationId,
    entity: createUserMembershipEntity(user.right),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })
  if (E.isLeft(membership)) throw new InvalidGroupMembershipRecordError()
  return membership.right
}

function toAgentMembership(row: AgentMembershipRow): Membership {
  const agent = AgentFactory.validate({
    id: row.agents.id,
    organizationId: row.agents.organizationId,
    agentName: row.agents.agentName,
    publicKey: Buffer.from(row.agents.base64PublicKey, "base64").toString("utf8"),
    status: toAgentStatus(row.agents.status),
    roles: row.agents.roles,
    createdAt: row.agents.createdAt,
    updatedAt: row.agents.updatedAt
  })
  if (E.isLeft(agent)) throw new InvalidGroupMembershipRecordError()
  const membership = MembershipFactory.validate({
    organizationId: row.organizationId,
    entity: createAgentMembershipEntity(agent.right),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })
  if (E.isLeft(membership)) throw new InvalidGroupMembershipRecordError()
  return membership.right
}

function toUserMembershipWithGroupRef(row: UserMembershipRow): MembershipWithGroupRef {
  const membership = toUserMembership(row)
  const withGroupRef = MembershipFactory.validateWithGroupRef({...membership, groupId: row.groupId})
  if (E.isLeft(withGroupRef)) throw new InvalidGroupMembershipRecordError()
  return withGroupRef.right
}

function toAgentMembershipWithGroupRef(row: AgentMembershipRow): MembershipWithGroupRef {
  const membership = toAgentMembership(row)
  const withGroupRef = MembershipFactory.validateWithGroupRef({...membership, groupId: row.groupId})
  if (E.isLeft(withGroupRef)) throw new InvalidGroupMembershipRecordError()
  return withGroupRef.right
}

function toMembershipStatus(status: string): MembershipStatus {
  if (status === "active") return MembershipStatus.ACTIVE
  if (status === "removed") return MembershipStatus.REMOVED
  throw new InvalidGroupMembershipRecordError()
}

function toOrgRole(role: string): OrgRole {
  if (role === "owner") return OrgRole.OWNER
  if (role === "admin") return OrgRole.ADMIN
  if (role === "member") return OrgRole.MEMBER
  throw new InvalidGroupMembershipRecordError()
}

function toAgentStatus(status: string): "active" | "revoked" {
  if (status === "active" || status === "revoked") return status
  throw new InvalidGroupMembershipRecordError()
}

class GroupMembershipNotFoundError extends Error {}
class OrganizationMismatchError extends Error {}
class ConcurrentModificationError extends Error {}
class InvalidGroupMembershipRecordError extends Error {}
