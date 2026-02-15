import {Quota, QuotaIdentifier, QuotaValidationError, Versioned} from "@domain"
import {ConcurrentModificationError, UnknownError} from "@services/error"
import {PrefixUnion} from "@utils"
import {TaskEither} from "fp-ts/lib/TaskEither"

export type QuotaGetError = PrefixUnion<"quota", "not_found" | UnknownError> | QuotaValidationError
export type QuotaCreateError = PrefixUnion<"quota", UnknownError | "already_exists"> | QuotaValidationError
export type QuotaUpdateError =
  | PrefixUnion<"quota", UnknownError | ConcurrentModificationError | "not_found">
  | QuotaValidationError

export interface QuotaRepository {
  getQuota(identifier: QuotaIdentifier): TaskEither<QuotaGetError, Versioned<Quota>>
  createQuota(quota: Quota): TaskEither<QuotaCreateError, Versioned<Quota>>
  updateQuota(quota: Quota, occCheck: bigint): TaskEither<QuotaUpdateError, Versioned<Quota>>
}
export const QUOTA_REPOSITORY_TOKEN = Symbol("QUOTA_REPOSITORY_TOKEN")
