import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "../error"

export const USER_IDENTITY_REPOSITORY_TOKEN = "USER_IDENTITY_REPOSITORY_TOKEN"

export interface UserIdentity {
  id: string
  userId: string
  providerId: string
  subjectId: string
  email: string
  createdAt: Date
}

export interface UserIdentityCreate {
  userId: string
  providerId: string
  subjectId: string
  email: string
}

export type UserIdentityGetError = "user_identity_not_found" | UnknownError
export type UserIdentityCreateError = "user_identity_already_exists" | UnknownError

export interface UserIdentityRepository {
  findById(id: string): TaskEither<UserIdentityGetError, UserIdentity>
  findByProviderAndSubject(providerId: string, subjectId: string): TaskEither<UserIdentityGetError, UserIdentity>
  create(userIdentity: UserIdentityCreate): TaskEither<UserIdentityCreateError, UserIdentity>
}
