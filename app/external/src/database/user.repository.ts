import {User} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {User as PrismaUser} from "@prisma/client"
import {UserCreateError, UserGetError, UserRepository} from "@services"
import {Versioned} from "@services/shared/utils"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {DatabaseClient} from "./database-client"
import {mapToDomainVersionedUser, mapUserToDomain} from "./shared"
import {chainNullableToLeft} from "./utils"

interface Identifier {
  identifier: string
  type: "id" | "email"
}

@Injectable()
export class UserDbRepository implements UserRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  createUser(user: User): TaskEither<UserCreateError, User> {
    return pipe(user, TE.right, TE.chainW(this.persistObjectTask()), TE.chainEitherKW(mapUserToDomain))
  }

  getUserById(userId: string): TaskEither<UserGetError, Versioned<User>> {
    const identifier: Identifier = {type: "id", identifier: userId}
    return this.getUser(identifier)
  }

  getUserByEmail(email: string): TaskEither<UserGetError, Versioned<User>> {
    const identifier: Identifier = {type: "email", identifier: email}
    return this.getUser(identifier)
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

  private persistObjectTask(): (user: User) => TaskEither<UserCreateError, PrismaUser> {
    return user =>
      TE.tryCatchK(
        () =>
          this.dbClient.user.create({
            data: {
              id: user.id,
              displayName: user.displayName,
              email: user.email,
              createdAt: user.createdAt,
              occ: POSTGRES_BIGINT_LOWER_BOUND,
              orgRole: user.orgRole
            }
          }),
        error => {
          if (isPrismaUniqueConstraintError(error, ["email"])) return "user_already_exists"

          Logger.error("Error while creating user. Unknown error", error)
          return "unknown_error"
        }
      )()
  }

  private getObjectTask(): (identifier: Identifier) => TaskEither<UserGetError, PrismaUser | null> {
    // Wrap in a lambda to preserve the "this" context
    return identifier =>
      TE.tryCatchK(
        () =>
          this.dbClient.user.findUnique({
            where: {
              id: identifier.type === "id" ? identifier.identifier : undefined,
              email: identifier.type === "email" ? identifier.identifier : undefined
            }
          }),
        error => {
          Logger.error("Error while retrieving user. Unknown error", error)
          return "unknown_error" as const
        }
      )()
  }
}
