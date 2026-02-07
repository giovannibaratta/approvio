import {User} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Prisma, User as PrismaUser, OrganizationAdmin as PrismaOrganizationAdmin} from "@prisma/client"
import {
  UserCreateError,
  UserGetError,
  UserRepository,
  UserListError,
  PaginatedUsersList,
  ListUsersRepoRequest,
  UserUpdateError
} from "@services"
import {Versioned} from "@domain"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {mapRolesToPrisma, mapToDomainUserSummary, mapToDomainVersionedUser, mapUserToDomain} from "./shared"
import {areAllRights, chainNullableToLeft} from "./utils"
import {isLeft} from "fp-ts/lib/Either"
import * as E from "fp-ts/lib/Either"
import {randomUUID} from "crypto"

interface Identifier {
  identifier: string
  type: "id" | "email"
}

export type UserSummaryRepo = Pick<PrismaUser, "id" | "displayName" | "email">
export type PrismaUserWithOrgAdmin = PrismaUser & {
  organizationAdmins: PrismaOrganizationAdmin | null
}

@Injectable()
export class UserDbRepository implements UserRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createUser(user: User): TaskEither<UserCreateError, User> {
    return pipe(user, TE.right, TE.chainW(this.persistObjectTask()), TE.chainEitherKW(mapUserToDomain))
  }

  createUserWithOrgAdmin(user: User): TaskEither<UserCreateError, User> {
    return pipe(user, TE.right, TE.chainW(this.persistUserWithOrgAdminTask()), TE.chainEitherKW(mapUserToDomain))
  }

  getUserById(userId: string): TaskEither<UserGetError, Versioned<User>> {
    const identifier: Identifier = {type: "id", identifier: userId}
    return this.getUser(identifier)
  }

  getUserByEmail(email: string): TaskEither<UserGetError, Versioned<User>> {
    const identifier: Identifier = {type: "email", identifier: email}
    return this.getUser(identifier)
  }

  listUsers(request: ListUsersRepoRequest): TaskEither<UserListError, PaginatedUsersList> {
    return pipe(
      request,
      TE.right,
      TE.chainW(this.getObjectsTask()),
      TE.chainEitherKW(([users, total]) => {
        const domainUsers = users.map(user => mapToDomainUserSummary(user))

        if (areAllRights(domainUsers)) {
          const mappedToDomain = {
            users: domainUsers.map(e => e.right),
            total,
            page: request.page,
            limit: request.limit
          }
          return E.right(mappedToDomain)
        }

        const lefts = domainUsers.filter(e => isLeft(e))
        const firstLeft = lefts[0]
        if (firstLeft === undefined) throw new Error("Unexpected error: No rights and no lefts")
        return firstLeft
      })
    )
  }

  hasAnyOrganizationAdmins(): TaskEither<"unknown_error", boolean> {
    return TE.tryCatchK(
      async () => {
        const count = await this.dbClient.organizationAdmin.count()
        return count > 0
      },
      error => {
        Logger.error("Error while checking for organization admins", error)
        return "unknown_error" as const
      }
    )()
  }

  updateUser(user: Versioned<User>): TaskEither<UserUpdateError, User> {
    return TE.tryCatchK(
      async (): Promise<User> => {
        const updatedUser = await this.dbClient.user.update({
          where: {id: user.id, occ: user.occ},
          data: {
            roles: mapRolesToPrisma(user.roles),
            occ: {
              increment: 1
            }
          },
          include: {
            organizationAdmins: true
          }
        })

        const mappedUser = mapUserToDomain(updatedUser)
        if (E.isLeft(mappedUser)) throw new Error("Failed to map updated user to domain")

        return mappedUser.right
      },
      error => {
        if (isPrismaUniqueConstraintError(error, ["occ"])) {
          Logger.warn("Optimistic concurrency control conflict during user role update", error)
          return "unknown_error" as const
        }

        Logger.error("Error while updating user roles", error)
        return "unknown_error" as const
      }
    )()
  }

  private getUser(identifier: Identifier): TaskEither<UserGetError, Versioned<User>> {
    return pipe(
      identifier,
      TE.right,
      TE.chainW(this.getObjectTask()),
      chainNullableToLeft("user_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedUser)
    )
  }

  private createUserInDb(dbClient: Prisma.TransactionClient, user: User): Promise<PrismaUserWithOrgAdmin> {
    return dbClient.user.create({
      data: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        createdAt: user.createdAt,
        occ: POSTGRES_BIGINT_LOWER_BOUND
      },
      include: {
        organizationAdmins: true
      }
    })
  }

  private persistObjectTask(): (user: User) => TaskEither<UserCreateError, PrismaUserWithOrgAdmin> {
    return user =>
      TE.tryCatchK(
        () => this.createUserInDb(this.dbClient, user),
        error => {
          if (isPrismaUniqueConstraintError(error, ["email"])) return "user_already_exists"
          if (isPrismaUniqueConstraintError(error, ["id"])) return "user_already_exists"

          Logger.error("Error while creating user. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private persistUserWithOrgAdminTask(): (user: User) => TaskEither<UserCreateError, PrismaUserWithOrgAdmin> {
    return user =>
      TE.tryCatchK(
        () =>
          this.dbClient.$transaction(async tx => {
            const createdUser = await this.createUserInDb(tx, user)

            const orgAdmin = await tx.organizationAdmin.create({
              data: {
                id: randomUUID(),
                email: user.email,
                createdAt: new Date()
              }
            })

            return {
              ...createdUser,
              organizationAdmins: orgAdmin
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["email"])) return "user_already_exists"

          Logger.error("Error while creating user with organization admin. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private getObjectTask(): (identifier: Identifier) => TaskEither<UserGetError, PrismaUserWithOrgAdmin | null> {
    // Wrap in a lambda to preserve the "this" context
    return identifier =>
      TE.tryCatchK(
        () =>
          this.dbClient.user.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              email: identifier.type === "email" ? identifier.identifier : undefined
            },
            include: {
              organizationAdmins: true
            }
          }),
        error => {
          Logger.error("Error while retrieving user. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }

  private getObjectsTask(): (request: ListUsersRepoRequest) => TaskEither<UserListError, [UserSummaryRepo[], number]> {
    return request =>
      TE.tryCatchK(
        () => {
          const {search, page, limit} = request
          const skip = (page - 1) * limit

          const whereClause: Prisma.UserWhereInput = this.buildWhereCloseForListingUsers(search)

          const data = this.dbClient.user.findMany({
            take: limit,
            skip,
            orderBy: {
              createdAt: "asc"
            },
            select: {
              id: true,
              displayName: true,
              email: true
            },
            where: whereClause
          })
          const stats = this.dbClient.user.count({where: whereClause})

          return this.dbClient.$transaction([data, stats], {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
          })
        },
        error => {
          Logger.error("Error while listing users.", error)
          return "unknown_error" as const
        }
      )()
  }

  private buildWhereCloseForListingUsers(search?: string): Prisma.UserWhereInput {
    const whereClause: Prisma.UserWhereInput = search
      ? {
          OR: [{displayName: {contains: search, mode: "insensitive"}}, {email: {contains: search, mode: "insensitive"}}]
        }
      : {}

    return whereClause
  }
}
