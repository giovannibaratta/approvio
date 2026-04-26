import {Quota, QuotaIdentifier, QuotaValidationError, Versioned, SupportedQuotaType, NodeType} from "@domain"
import {ConcurrentModificationError, UnknownError, PaginationError, AuthorizationError} from "@services/error"
import {PrefixUnion} from "@utils"
import {TaskEither} from "fp-ts/TaskEither"
import {UserGetError} from "../user/interfaces"
import {FindVotesError} from "../vote/interfaces"

export type QuotaGetError = PrefixUnion<"quota", "not_found" | UnknownError> | QuotaValidationError
export type QuotaCreateError =
  | PrefixUnion<"quota", UnknownError | "already_exists">
  | QuotaValidationError
  | AuthorizationError
export type QuotaUpdateError =
  | PrefixUnion<"quota", UnknownError | ConcurrentModificationError | "not_found">
  | QuotaValidationError
  | AuthorizationError
export type QuotaListError = PaginationError | PrefixUnion<"quota", UnknownError> | QuotaValidationError
export type QuotaDeleteError = PrefixUnion<"quota", "not_found" | UnknownError> | AuthorizationError
export type QuotaUsageError = UnknownError | UserGetError | FindVotesError
export type QuotaCheckError = QuotaGetError | QuotaUsageError | "quota_unsupported_quota_type_for_node"

export type ListQuotasFilter = {
  readonly nodeType?: NodeType
  readonly quotaType?: SupportedQuotaType
  readonly nodeIdentifier?: string
}

export interface ListQuotasResult {
  readonly items: Versioned<Quota>[]
  readonly total: number
  readonly page: number
  readonly limit: number
}

export interface QuotaRepository {
  getQuota(identifier: QuotaIdentifier): TaskEither<QuotaGetError, Versioned<Quota>>
  getQuotaById(id: string): TaskEither<QuotaGetError, Versioned<Quota>>
  createQuota(quota: Quota): TaskEither<QuotaCreateError, Versioned<Quota>>
  updateQuota(quota: Quota, occCheck: bigint): TaskEither<QuotaUpdateError, Versioned<Quota>>
  deleteQuota(id: string): TaskEither<QuotaDeleteError, void>
  listQuotas(page: number, limit: number, filter?: ListQuotasFilter): TaskEither<QuotaListError, ListQuotasResult>
}
export const QUOTA_REPOSITORY_TOKEN = Symbol("QUOTA_REPOSITORY_TOKEN")
