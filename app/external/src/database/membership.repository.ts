import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {mapRolesToPrisma} from "./shared"
import {fromPromise, fromEitherPromise} from "./repository-operation"
import {chainNullableToLeft} from "./utils"
import {Injectable} from "@nestjs/common"
import {MembershipStatus, OrgRole, TenantContext, User, UserFactory, UserValidationError} from "@domain"
import {MembershipRepository, RepositoryDependencyError, VersionedMembership} from "@services"
import {Prisma, User as PrismaUser} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {MembershipTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"

type MembershipError =
  | "resource_not_found"
  | "resource_already_exists"
  | "concurrent_modification_error"
  | UserValidationError
  | RepositoryDependencyError

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
    return fromEitherPromise(
      async () => {
        this.dbClient.assertIsolationLevel(Prisma.TransactionIsolationLevel.RepeatableRead)
        const where = {organizationId: context.organizationId}
        const [records, total] = await Promise.all([
          this.dbClient.cx.user.findMany({where, orderBy: {id: "asc"}, skip: (page - 1) * limit, take: limit}),
          this.dbClient.cx.user.count({where})
        ])
        return E.map((items: ReadonlyArray<VersionedMembership>) => ({items, total}))(
          E.sequenceArray(
            records.map(record => E.map((membership: User) => ({membership, occ: record.occ}))(mapMembership(record)))
          )
        )
      },
      error => this.mapError(error)
    )
  }

  create(membership: User): TE.TaskEither<MembershipError, VersionedMembership> {
    return fromEitherPromise(
      async () => {
        const record = await this.dbClient.cx.user.create({
          data: {
            id: membership.id,
            organizationId: membership.organizationId,
            platformAccountId: membership.accountId,
            displayName: membership.displayName,
            status: membership.status,
            orgRole: membership.orgRole,
            roles: mapRolesToPrisma(membership.roles),
            createdAt: membership.createdAt,
            updatedAt: membership.updatedAt,
            occ: POSTGRES_BIGINT_LOWER_BOUND
          }
        })
        return E.map((membership: User) => ({membership, occ: record.occ}))(mapMembership(record))
      },
      error => this.mapError(error)
    )
  }

  update(
    context: TenantContext,
    previous: VersionedMembership,
    membership: User
  ): TE.TaskEither<MembershipError, VersionedMembership> {
    return fromEitherPromise(
      async () => {
        const record = await this.dbClient.cx.user.update({
          where: {
            organizationId_id: {organizationId: context.organizationId, id: membership.id},
            occ: previous.occ
          },
          data: {
            status: membership.status,
            orgRole: membership.orgRole,
            roles: mapRolesToPrisma(membership.roles),
            updatedAt: membership.updatedAt,
            occ: {increment: 1}
          }
        })
        return E.map((membership: User) => ({membership, occ: record.occ}))(mapMembership(record))
      },
      error => (isPrismaRecordNotFoundError(error, "User") ? "concurrent_modification_error" : this.mapError(error))
    )
  }

  countActiveOwners(context: TenantContext): TE.TaskEither<RepositoryDependencyError, number> {
    return fromPromise(
      () =>
        this.dbClient.cx.user.count({
          where: {organizationId: context.organizationId, status: MembershipStatus.ACTIVE, orgRole: OrgRole.OWNER}
        }),
      () => "repository_dependency_error" as const
    )
  }

  private get(where: Prisma.UserWhereUniqueInput): TE.TaskEither<MembershipError, VersionedMembership> {
    return pipe(
      fromPromise(
        () => this.dbClient.cx.user.findUnique({where}),
        error => this.mapError(error)
      ),
      chainNullableToLeft("resource_not_found" as const),
      TE.chainEitherKW(record => E.map((membership: User) => ({membership, occ: record.occ}))(mapMembership(record)))
    )
  }

  private mapError(error: unknown): MembershipError {
    // PostgreSQL omits conflicting column details under tenant RLS; retain the named-constraint fallback.
    if (
      isPrismaUniqueConstraintError(
        error,
        ["organization_id", "platform_account_id"],
        "users_organization_account_unique"
      )
    )
      return "resource_already_exists"
    // Infrastructure failures must reach the transaction boundary, which owns retries.
    return "repository_dependency_error" as const
  }
}

function mapMembership(record: PrismaUser): E.Either<UserValidationError, User> {
  return UserFactory.validate({
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
}
