import {User, UserFactory} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {USER_REPOSITORY_TOKEN, UserCreateError, UserGetError, UserRepository} from "./interfaces"
import {Versioned} from "@services/shared/utils"
import {isEmail, isUUIDv4} from "@utils"
import {RequestorAwareRequest} from "@services/shared/types"

@Injectable()
export class UserService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository
  ) {}

  createUser(request: CreateUserRequest): TaskEither<UserCreateError, User> {
    // Wrap repository call in a lambda to preserve "this" context
    const persistUser = (user: User) => this.userRepo.createUser(user)

    const validateRequest = (req: CreateUserRequest) => {
      if (req.requestor.orgRole !== "admin") return E.left("requestor_not_authorized" as const)
      return UserFactory.newUser(req.userData)
    }

    return pipe(request, validateRequest, TE.fromEither, TE.chainW(persistUser))
  }

  getUserByIdentifier(userIdentifier: string): TaskEither<UserGetError, Versioned<User>> {
    const isUuid = isUUIDv4(userIdentifier)
    const isValidEmail = isEmail(userIdentifier)

    if (!isUuid && !isValidEmail) return TE.left("invalid_identifier")

    // Wrap in a lambda to preserve the "this" context
    const repoGetUser = (value: string) =>
      isUuid ? this.userRepo.getUserById(value) : this.userRepo.getUserByEmail(value)

    return pipe(userIdentifier, TE.right, TE.chainW(repoGetUser))
  }
}

export interface CreateUserRequest extends RequestorAwareRequest {
  userData: Parameters<typeof UserFactory.newUser>[0]
}
