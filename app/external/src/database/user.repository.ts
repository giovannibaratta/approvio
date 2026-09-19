import {fromPromise, fromEitherPromise} from "./repository-operation"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {Injectable, Logger} from "@nestjs/common"
import {
  TenantContext,
  User,
  UserFactory,
  UserSummary,
  UserSummaryValidationError,
  UserValidationError,
  Versioned
} from "@domain"
import {
  ListUsersRepoRequest,
  PaginatedUsersList,
  UserCreateError,
  UserGetError,
  UserListError,
  UserRepository,
  UserUpdateError
} from "@services"
import {Prisma, User as PrismaUser} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {UserTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {mapToDomainVersionedUser, mapRolesToPrisma} from "./shared"
import {chainNullableToLeft} from "./utils"

type UserSummaryRepo = Pick<
  PrismaUser,
  "id" | "organizationId" | "platformAccountId" | "displayName" | "status" | "orgRole"
>

@Injectable()
export class UserDbRepository implements UserRepository {
  constructor(private readonly dbClient: UserTenantClient) {}

  createUser(user: User): TaskEither<UserCreateError, User> {
    return pipe(user, TE.right, TE.chainW(this.persistObjectTask()), TE.chainEitherKW(mapUserToDomain))
  }

  getUserById(context: TenantContext, userId: string): TaskEither<UserGetError, Versioned<User>> {
    return this.getUser(context, userId)
  }

  listUsers(context: TenantContext, request: ListUsersRepoRequest): TaskEither<UserListError, PaginatedUsersList> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getObjectsTask(context)),
      TE.chainEitherKW(([users, total]) =>
        pipe(
          E.traverseArray(mapToDomainUserSummary)(users),
          E.map(users => ({users: [...users], total, page: request.page, limit: request.limit}))
        )
      )
    )
  }

  updateUser(context: TenantContext, user: Versioned<User>): TaskEither<UserUpdateError, Versioned<User>> {
    return fromEitherPromise(
      async () => {
        const updatedUser = await this.dbClient.cx.user.update({
          where: {id: user.id, organizationId: context.organizationId, occ: user.occ},
          data: {
            displayName: user.displayName,
            status: user.status,
            orgRole: user.orgRole,
            roles: mapRolesToPrisma(user.roles),
            updatedAt: user.updatedAt,
            occ: {increment: 1}
          }
        })
        return mapToDomainVersionedUser(updatedUser)
      },
      error => {
        // Prisma uses P2025 when the row is missing or its OCC version no longer matches.
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) {
          Logger.warn("Optimistic concurrency control conflict during user role update", error)
          return "concurrent_modification_error" as const
        }

        Logger.error("Error while updating user roles", error)
        return "unknown_error" as const
      }
    )
  }

  private getUser(context: TenantContext, userId: string): TaskEither<UserGetError, Versioned<User>> {
    return pipe(
      userId,
      TE.right,
      TE.chainW(this.getObjectTask(context)),
      chainNullableToLeft("user_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedUser)
    )
  }

  private createUserInDb(user: User): Promise<PrismaUser> {
    return this.dbClient.cx.user.create({
      data: {
        id: user.id,
        organizationId: user.organizationId,
        platformAccountId: user.accountId,
        displayName: user.displayName,
        status: user.status,
        orgRole: user.orgRole,
        roles: mapRolesToPrisma(user.roles),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        occ: POSTGRES_BIGINT_LOWER_BOUND
      }
    })
  }

  private persistObjectTask(): (user: User) => TaskEither<UserCreateError, PrismaUser> {
    return user =>
      fromPromise(
        () => this.createUserInDb(user),
        error => {
          if (
            isPrismaUniqueConstraintError(
              error,
              ["organization_id", "platform_account_id"],
              "users_organization_account_unique"
            )
          )
            return "user_already_exists"

          Logger.error("Error while creating user. Unknown error", error)
          return "unknown_error"
        }
      )
  }

  private getObjectTask(context: TenantContext): (userId: string) => TaskEither<UserGetError, PrismaUser | null> {
    // Wrap in a lambda to preserve the "this" context
    return userId =>
      fromPromise(
        () =>
          this.dbClient.cx.user.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: userId}}
          }),
        error => {
          Logger.error("Error while retrieving user. Unknown error", error)
          return "unknown_error" as const
        }
      )
  }

  private getObjectsTask(
    context: TenantContext
  ): (request: ListUsersRepoRequest) => TaskEither<UserListError, [UserSummaryRepo[], number]> {
    return request =>
      fromPromise(
        async (): Promise<[UserSummaryRepo[], number]> => {
          const {search, page, limit} = request
          const skip = (page - 1) * limit
          const whereClause: Prisma.UserWhereInput = this.buildWhereCloseForListingUsers(context, search)

          const data = this.dbClient.cx.user.findMany({
            take: limit,
            skip,
            orderBy: [{displayName: "asc"}, {id: "asc"}],
            select: {
              id: true,
              organizationId: true,
              platformAccountId: true,
              displayName: true,
              status: true,
              orgRole: true
            },
            where: whereClause
          })
          const stats = this.dbClient.cx.user.count({where: whereClause})

          const [resolvedData, resolvedStats] = await Promise.all([data, stats])
          return [resolvedData, resolvedStats]
        },
        error => {
          Logger.error("Error while listing users.", error)
          return "unknown_error" as const
        }
      )
  }

  private buildWhereCloseForListingUsers(context: TenantContext, search?: string): Prisma.UserWhereInput {
    const whereClause: Prisma.UserWhereInput = {
      organizationId: context.organizationId,
      ...(search
        ? {
            OR: [
              {displayName: {contains: search, mode: "insensitive"}},
              {platformAccounts: {profileEmail: {equals: search, mode: "insensitive"}}}
            ]
          }
        : {})
    }

    return whereClause
  }
}

function mapUserToDomain(record: PrismaUser): E.Either<UserValidationError, User> {
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

function mapToDomainUserSummary(record: UserSummaryRepo): E.Either<UserSummaryValidationError, UserSummary> {
  const summary = {
    id: record.id,
    organizationId: record.organizationId,
    accountId: record.platformAccountId,
    displayName: record.displayName,
    status: record.status,
    orgRole: record.orgRole
  }
  return UserFactory.validateUserSummary(summary)
}
