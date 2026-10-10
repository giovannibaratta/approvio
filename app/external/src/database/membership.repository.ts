import {Injectable} from "@nestjs/common"
import {MembershipStatus, OrgRole, TenantContext, User, UserFactory} from "@domain"
import {MembershipRepository, RepositoryDependencyError, VersionedMembership} from "@services"
import {Prisma, User as PrismaUser} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {MembershipTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

type MembershipError =
  "resource_not_found" | "resource_already_exists" | "concurrent_modification_error" | RepositoryDependencyError

@Injectable()
export class MembershipDbRepository implements MembershipRepository {
  constructor(private readonly dbClient: MembershipTenantClient) {}

  getByAccount(context: TenantContext, accountId: string): TE.TaskEither<MembershipError, VersionedMembership> {
    return this.get({
      organizationId_platformAccountId: {organizationId: context.organizationId, platformAccountId: accountId}
    })
  }

  getById(context: TenantContext, userId: string): TE.TaskEither<MembershipError, VersionedMembership> {
    return this.get({organizationId_id: {organizationId: context.organizationId, id: userId}})
  }

  list(
    context: TenantContext,
    page: number,
    limit: number
  ): TE.TaskEither<MembershipError, {readonly items: ReadonlyArray<VersionedMembership>; readonly total: number}> {
    return TE.tryCatch(
      async () => {
        const where = {organizationId: context.organizationId}
        const [records, total] = await Promise.all([
          this.dbClient.cx.user.findMany({where, orderBy: {id: "asc"}, skip: (page - 1) * limit, take: limit}),
          this.dbClient.cx.user.count({where})
        ])
        return {items: records.map(record => ({membership: mapMembership(record), occ: record.occ.toString()})), total}
      },
      error => this.mapError(error)
    )
  }

  create(context: TenantContext, membership: User): TE.TaskEither<MembershipError, VersionedMembership> {
    return TE.tryCatch(
      async () => {
        const record = await this.dbClient.cx.user.create({
          data: {
            id: membership.id,
            organizationId: context.organizationId,
            platformAccountId: membership.accountId,
            displayName: membership.displayName,
            status: membership.status,
            orgRole: membership.orgRole,
            roles:
              membership.roles.length === 0
                ? Prisma.JsonNull
                : membership.roles.map(role => ({name: role.name, scope: {...role.scope}})),
            createdAt: membership.createdAt,
            updatedAt: membership.updatedAt,
            occ: 0n
          }
        })
        return {membership: mapMembership(record), occ: record.occ.toString()}
      },
      error => this.mapError(error)
    )
  }

  update(
    context: TenantContext,
    previous: VersionedMembership,
    membership: User
  ): TE.TaskEither<MembershipError, VersionedMembership> {
    return TE.tryCatch(
      async () => {
        const record = await this.dbClient.cx.user.update({
          where: {
            organizationId_id: {organizationId: context.organizationId, id: membership.id},
            occ: BigInt(previous.occ),
            status: previous.membership.status
          },
          data: {
            status: membership.status,
            orgRole: membership.orgRole,
            roles:
              membership.roles.length === 0
                ? Prisma.JsonNull
                : membership.roles.map(role => ({name: role.name, scope: {...role.scope}})),
            updatedAt: membership.updatedAt,
            occ: {increment: 1}
          }
        })
        if (membership.status === MembershipStatus.REMOVED)
          await this.dbClient.cx.groupMembership.deleteMany({
            where: {organizationId: context.organizationId, userId: membership.id}
          })
        return {membership: mapMembership(record), occ: record.occ.toString()}
      },
      error => (isPrismaRecordNotFoundError(error, "User") ? "concurrent_modification_error" : this.mapError(error))
    )
  }

  countActiveOwners(context: TenantContext): TE.TaskEither<RepositoryDependencyError, number> {
    return TE.tryCatch(
      () =>
        this.dbClient.cx.user.count({
          where: {organizationId: context.organizationId, status: MembershipStatus.ACTIVE, orgRole: OrgRole.OWNER}
        }),
      error => {
        throw error
      }
    )
  }

  private get(where: Prisma.UserWhereUniqueInput): TE.TaskEither<MembershipError, VersionedMembership> {
    return TE.tryCatch(
      async () => {
        const record = await this.dbClient.cx.user.findUnique({where})
        if (!record) throw new MembershipNotFoundError()
        return {membership: mapMembership(record), occ: record.occ.toString()}
      },
      error => this.mapError(error)
    )
  }

  private mapError(error: unknown): MembershipError {
    if (error instanceof MembershipNotFoundError) return "resource_not_found"
    if (isPrismaUniqueConstraintError(error, ["organization_id", "platform_account_id"]))
      return "resource_already_exists"
    // Infrastructure failures must reach the transaction boundary, which owns retries.
    throw error
  }
}

function mapMembership(record: PrismaUser): User {
  const mapped = UserFactory.validate({
    id: record.id,
    organizationId: record.organizationId,
    accountId: record.platformAccountId,
    displayName: record.displayName,
    status: record.status,
    orgRole: record.orgRole,
    roles: record.roles,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  })
  if (E.isLeft(mapped)) throw new Error("Invalid membership record")
  return mapped.right
}

class MembershipNotFoundError extends Error {}
