import {OrgRole, User, UserFactory} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError, UnknownError} from "@services/error"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {USER_REPOSITORY_TOKEN, UserCreateError, UserGetError, UserRepository} from "./interfaces"
import {Versioned} from "@domain"
import {isEmail, isUUIDv4} from "@utils"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"
import {PaginatedUsersList, UserListError} from "./interfaces"

const MIN_PAGE = 1
const MIN_LIMIT = 1
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const MAX_SEARCH_LENGTH = 100

@Injectable()
export class UserService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository
  ) {}

  createUser(request: CreateUserRequest): TaskEither<UserCreateError | AuthorizationError, User> {
    // Wrap repository call in a lambda to preserve "this" context
    const persistUser = (user: User) => this.userRepo.createUser(user)

    const validateRequest = (req: CreateUserRequest, requestor: User) => {
      if (requestor.orgRole !== "admin") return E.left("requestor_not_authorized" as const)
      return UserFactory.newUser(req.userData)
    }

    return pipe(
      validateUserEntity(request.requestor),
      E.chainW(requestor => validateRequest(request, requestor)),
      TE.fromEither,
      TE.chainW(persistUser)
    )
  }

  getUserByIdentifier(userIdentifier: string): TaskEither<UserGetError, Versioned<User>> {
    const isUuid = isUUIDv4(userIdentifier)
    const isValidEmail = isEmail(userIdentifier)

    if (!isUuid && !isValidEmail) return TE.left("request_invalid_user_identifier")

    // Wrap in a lambda to preserve the "this" context
    const repoGetUser = (value: string) =>
      isUuid ? this.userRepo.getUserById(value) : this.userRepo.getUserByEmail(value)

    return pipe(userIdentifier, TE.right, TE.chainW(repoGetUser))
  }

  listUsers(request: ListUsersRequest): TaskEither<UserListError, PaginatedUsersList> {
    const {search} = request
    const page = request.page ?? 1
    const limit = request.limit ?? DEFAULT_LIMIT

    if (page < MIN_PAGE) return TE.left("invalid_page_number")
    if (limit < MIN_LIMIT || limit > MAX_LIMIT) return TE.left("invalid_limit_number")
    if (search !== undefined) {
      if (search.length > MAX_SEARCH_LENGTH) return TE.left("search_too_long")
      if (!search.match(/^[a-zA-Z0-9@.%_+.-]+$/)) return TE.left("search_term_invalid_characters")
    }

    return this.userRepo.listUsers({search, page, limit})
  }

  /**
   * Auto-registers a new user from OIDC provider claims with automatic role assignment.
   * Implements the "first user becomes admin" pattern for initial system setup.
   *
   * @param request - User registration data containing email and display name from OIDC provider
   * @returns TaskEither with AutoRegisterError on failure or User domain object on success
   *
   * Business Rules:
   * 1. First registered user automatically becomes organization admin
   * 2. Subsequent users are registered as regular users
   *
   * Flow:
   * 1. Check if any organization admins exist in the system
   * 2. Create user with admin role if no admins exist (first user scenario)
   * 3. Create regular user if admins already exist
   * 4. Persist user with appropriate privileges based on role
   */
  autoRegisterOidcUser(request: AutoRegisterOidcUserRequest): TaskEither<AutoRegisterError, User> {
    const persistUser = (user: User) => {
      if (user.orgRole === OrgRole.ADMIN) return this.userRepo.createUserWithOrgAdmin(user)
      return this.userRepo.createUser(user)
    }

    const createUserFromOidcClaims = (isFirstUser: boolean) => {
      return TE.fromEither(
        UserFactory.newUserFromOidc(
          {
            email: request.email,
            displayName: request.displayName
          },
          isFirstUser
        )
      )
    }

    return pipe(
      this.userRepo.hasAnyOrganizationAdmins(),
      TE.chainW(hasAdmins => createUserFromOidcClaims(!hasAdmins)),
      TE.chainW(user => persistUser(user))
    )
  }
}

export interface CreateUserRequest extends RequestorAwareRequest {
  userData: Parameters<typeof UserFactory.newUser>[0]
}

export interface ListUsersRequest {
  readonly search?: string
  readonly page?: number
  readonly limit?: number
}

export interface AutoRegisterOidcUserRequest {
  readonly email: string
  readonly displayName: string
}

export type AutoRegisterError = UserCreateError | UnknownError
