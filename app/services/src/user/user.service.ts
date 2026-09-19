import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {USER_REPOSITORY_TOKEN, UserRepository} from "./interfaces"
import {logSuccess} from "@utils"
import {RequestorAwareRequest} from "@services/shared/types"
import {PaginatedUsersList, UserListError} from "./interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"

const MIN_PAGE = 1
const MIN_LIMIT = 1
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
const MAX_SEARCH_LENGTH = 100

@Injectable()
export class UserService {
  constructor(
    @Inject(USER_REPOSITORY_TOKEN) private readonly userRepo: UserRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly transactionManager: TenantTransactionManager
  ) {}

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
