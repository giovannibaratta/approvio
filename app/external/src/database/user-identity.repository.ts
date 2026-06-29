import {Injectable} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DatabaseClient} from "./database-client"
import {
  UserIdentity,
  UserIdentityCreate,
  UserIdentityCreateError,
  UserIdentityGetError,
  UserIdentityRepository
} from "@services/user-identity/interfaces"
import {isPrismaUniqueConstraintError} from "./errors"
import {v7 as uuidv7} from "uuid"

@Injectable()
export class UserIdentityDbRepository implements UserIdentityRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  findById(id: string): TaskEither<UserIdentityGetError, UserIdentity> {
    return pipe(
      TE.tryCatch(
        async () => {
          const record = await this.dbClient.cx.userIdentity.findUnique({
            where: {id}
          })
          if (!record) throw new Error("user_identity_not_found")
          return record
        },
        error => {
          if (error instanceof Error && error.message === "user_identity_not_found")
            return "user_identity_not_found" as const
          return error as UserIdentityGetError
        }
      ),
      TE.map(record => ({
        id: record.id,
        userId: record.userId,
        providerId: record.providerId,
        subjectId: record.subjectId,
        email: record.email,
        createdAt: record.createdAt
      }))
    )
  }

  findByProviderAndSubject(providerId: string, subjectId: string): TaskEither<UserIdentityGetError, UserIdentity> {
    return pipe(
      TE.tryCatch(
        async () => {
          const record = await this.dbClient.cx.userIdentity.findUnique({
            where: {
              providerId_subjectId: {
                providerId,
                subjectId
              }
            }
          })
          if (!record) throw new Error("user_identity_not_found")
          return record
        },
        error => {
          if (error instanceof Error && error.message === "user_identity_not_found")
            return "user_identity_not_found" as const
          return error as UserIdentityGetError
        }
      ),
      TE.map(record => ({
        id: record.id,
        userId: record.userId,
        providerId: record.providerId,
        subjectId: record.subjectId,
        email: record.email,
        createdAt: record.createdAt
      }))
    )
  }

  create(userIdentity: UserIdentityCreate): TaskEither<UserIdentityCreateError, UserIdentity> {
    return pipe(
      TE.tryCatch(
        async () => {
          const id = uuidv7()
          const record = await this.dbClient.cx.userIdentity.create({
            data: {
              id,
              userId: userIdentity.userId,
              providerId: userIdentity.providerId,
              subjectId: userIdentity.subjectId,
              email: userIdentity.email
            }
          })
          return record
        },
        error => {
          if (isPrismaUniqueConstraintError(error, ["provider_id", "subject_id"]))
            return "user_identity_already_exists" as const
          return error as UserIdentityCreateError
        }
      ),
      TE.map(record => ({
        id: record.id,
        userId: record.userId,
        providerId: record.providerId,
        subjectId: record.subjectId,
        email: record.email,
        createdAt: record.createdAt
      }))
    )
  }
}
