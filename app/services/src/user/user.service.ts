import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  USER_REPOSITORY_TOKEN,
  UserRepository,
  GetUserError,
  UserDetails,
  PaginatedUsersList,
  UserListError
} from "./interfaces"
import {isUUIDv7, logSuccess} from "@utils"
import {RequestorAwareRequest} from "@services/shared/types"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {GROUP_REPOSITORY_TOKEN, GroupRepository} from "../group/interfaces"

const MIN_PAGE = 1
const MIN_LIMIT = 1
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const MAX_SEARCH_LENGTH = 100

@Injectable()
export class UserService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository,
    @Inject(GROUP_REPOSITORY_TOKEN) private readonly groupRepo: GroupRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactionManager: TenantTransactionManager
  ) {}

  getUser(request: GetUserRequest): TaskEither<GetUserError, UserDetails> {
    if (!isUUIDv7(request.userId)) return TE.left("request_invalid_user_identifier")

    return this.transactionManager.execute(request, () =>
      pipe(
        TE.Do,
        TE.bindW("user", () => this.userRepo.getUserById(request, request.userId)),
        TE.bindW("groups", () => this.groupRepo.getGroupsByUserId(request, request.userId))
      )
    )
  }

  listUsers(request: ListUsersRequest): TaskEither<UserListError, PaginatedUsersList> {
    const {search} = request
    const page = request.page ?? 1
    const limit = request.limit ?? DEFAULT_LIMIT

    if (page < MIN_PAGE) return TE.left("invalid_page_number")
    if (limit < MIN_LIMIT || limit > MAX_LIMIT) return TE.left("invalid_limit_number")
    if (search !== undefined) {
      if (search.length > MAX_SEARCH_LENGTH) return TE.left("search_too_long")
      // Reject whitespace-only searches
      if (search.trim() === "") return TE.left("search_term_invalid_characters")
      // Allow alphanumeric, spaces, email chars, and basic punctuation
      if (!search.match(/^[a-zA-Z0-9@.%_+.\s-]+$/)) return TE.left("search_term_invalid_characters")
    }

    return this.transactionManager.execute<UserListError, PaginatedUsersList>(request, () =>
      pipe(
        this.userRepo.listUsers({organizationId: request.organizationId}, {search, page, limit}),
        logSuccess("Users listed", "UserService", result => ({count: result.users.length}))
      )
    )
  }
}

export interface ListUsersRequest extends RequestorAwareRequest {
  readonly search?: string
  readonly page?: number
  readonly limit?: number
}

export interface GetUserRequest extends RequestorAwareRequest {
  readonly userId: string
}
