import {Injectable, Logger} from "@nestjs/common"
import {TenantContext, User, UserFactory, UserSummary, Versioned} from "@domain"
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
import {pipe} from "fp-ts/function"
import {UserTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {mapToDomainVersionedUser} from "./shared"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class UserDbRepository implements UserRepository {
  constructor(private readonly dbClient: UserTenantClient) {}

  createUser(context: TenantContext, user: User): TE.TaskEither<UserCreateError, User> {
    if (user.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () =>
        mapUser(
          await this.dbClient.cx.user.create({
            data: {
              id: user.id,
              organizationId: context.organizationId,
              platformAccountId: user.accountId,
              displayName: user.displayName,
              status: user.status,
              orgRole: user.orgRole,
              roles: rolesToJson(user.roles),
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
              occ: 0n
            }
          })
        ),
      error => this.mapCreateError(error)
    )
  }

  getUserById(context: TenantContext, userId: string): TE.TaskEither<UserGetError, Versioned<User>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.user.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: userId}}
          }),
        error => this.mapGetError(error)
      ),
      chainNullableToLeft("user_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedUser)
    )
  }

  listUsers(context: TenantContext, params: ListUsersRepoRequest): TE.TaskEither<UserListError, PaginatedUsersList> {
    if (params.page < 1) return TE.left("invalid_page_number")
    if (params.limit < 1) return TE.left("invalid_limit_number")
    if (params.search && params.search.length > 255) return TE.left("search_too_long")
    return TE.tryCatch(
      async () => {
        const where: Prisma.UserWhereInput = {
          organizationId: context.organizationId,
          ...(params.search
            ? {
                OR: [
                  {displayName: {contains: params.search, mode: "insensitive"}},
                  {platformAccounts: {profileEmail: {equals: params.search, mode: "insensitive"}}}
                ]
              }
            : {})
        }
        const [records, total] = await Promise.all([
          this.dbClient.cx.user.findMany({
            where,
            orderBy: [{displayName: "asc"}, {id: "asc"}],
            skip: (params.page - 1) * params.limit,
            take: params.limit
          }),
          this.dbClient.cx.user.count({where})
        ])
        return {users: records.map(mapSummary), page: params.page, limit: params.limit, total}
      },
      error => this.mapListError(error)
    )
  }

  updateUser(context: TenantContext, user: Versioned<User>): TE.TaskEither<UserUpdateError, Versioned<User>> {
    if (user.organizationId !== context.organizationId) return TE.left("organization_mismatch")
    return TE.tryCatch(
      async () => {
        try {
          const updated = await this.dbClient.cx.user.update({
            where: {id: user.id, organizationId: context.organizationId, occ: user.occ},
            data: {
              displayName: user.displayName,
              status: user.status,
              orgRole: user.orgRole,
              roles: rolesToJson(user.roles),
              updatedAt: user.updatedAt,
              occ: {increment: 1}
            }
          })
          return {...mapUser(updated), occ: updated.occ}
        } catch (error) {
          if (isPrismaRecordNotFoundError(error, Prisma.ModelName.User)) {
            const exists = await this.dbClient.cx.user.findUnique({
              where: {organizationId_id: {organizationId: context.organizationId, id: user.id}}
            })
            if (!exists) throw new UserNotFoundError()
            throw new UserConflictError()
          }
          throw error
        }
      },
      error => this.mapUpdateError(error)
    )
  }

  private mapCreateError(error: unknown): UserCreateError {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "platform_account_id"])) return "user_already_exists"
    Logger.error("User repository create failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapGetError(error: unknown): UserGetError {
    Logger.error("User repository get failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapListError(error: unknown): UserListError {
    Logger.error("User repository list failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }

  private mapUpdateError(error: unknown): UserUpdateError {
    if (error instanceof UserNotFoundError) return "user_not_found"
    if (error instanceof UserConflictError) return "concurrent_modification_error"
    Logger.error("User repository update failed", error instanceof Error ? error.name : "non_error")
    return "unknown_error"
  }
}

function mapUser(record: PrismaUser): User {
  const parsed = UserFactory.validate({
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
  if (E.isLeft(parsed)) throw new Error("Invalid user record")
  return parsed.right
}

function mapSummary(record: PrismaUser): UserSummary {
  const summary = {
    id: record.id,
    organizationId: record.organizationId,
    accountId: record.platformAccountId,
    displayName: record.displayName,
    status: record.status,
    orgRole: record.orgRole
  }
  const validated = UserFactory.validateUserSummary(summary)
  if (E.isLeft(validated)) throw new Error("Invalid user summary record")
  return validated.right
}

class UserNotFoundError extends Error {}
class UserConflictError extends Error {}

function rolesToJson(roles: User["roles"]): Prisma.JsonArray {
  return roles.map(role => ({...role, permissions: [...role.permissions], scope: {...role.scope}}))
}
