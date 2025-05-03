import {OrgRole, User, UserFactory} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {USER_REPOSITORY_TOKEN, UserCreateError, UserRepository} from "@services/user"
import {pipe} from "fp-ts/lib/function"
import {TaskEither} from "fp-ts/lib/TaskEither"
import * as TE from "fp-ts/lib/TaskEither"

@Injectable()
export class DebugService {
  /**
   * This service should only be loaded and used for debugging and testing purposes. Once all the
   * logic for authentication and authorization will be implemented, there should be no need for it.
   */
  constructor(
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepository: UserRepository
  ) {}

  /**
   * Create an ORG Admin user for the given email
   * @param email
   * @returns
   */
  createDebugUser(email: string): TaskEither<UserCreateError, User> {
    const persistUser = (user: User) => this.userRepository.createUser(user)

    return pipe(
      {orgRole: OrgRole.ADMIN.valueOf(), displayName: "Debug user", email},
      UserFactory.newUser,
      TE.fromEither,
      TE.chainW(persistUser)
    )
  }
}
