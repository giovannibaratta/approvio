import {Either, left, right} from "fp-ts/Either"
import {isUUIDv7} from "@utils"

export type AccountStatus = "active" | "disabled"
const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 255

/**
 * Platform login identity. It is not an organization principal: each
 * organization resolves this account to a separate local membership/user.
 */
export interface Account {
  readonly id: string
  readonly displayName: string
  /** OIDC profile data, absent when a provider does not assert an email. */
  // TODO: Do we want to allow in our internal domain model an empty profile or do we want to
  // validate at the boundary that an empty assertion is not valid (supported) ?
  readonly profileEmail: string | null
  readonly status: AccountStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type AccountValidationError =
  | "account_invalid_uuid"
  | "account_display_name_empty"
  | "account_display_name_too_long"
  | "account_invalid_status"
  | "account_update_before_create"

export class AccountFactory {
  // TODO: Other validate factory in the domain acccept an unknow object, do we want to do the same here?
  // Validation should be performed by the domain an not the persistence layer. Swapping the persistent
  // layer might risk losing a validation. Persitence layer could be doing some basic validations, but the
  // heavy lifting should be done here. Basically only domain and service should allow to construct an Account.
  // TODO: Is there a way to enforce this general concept with eslint rules ?

  // This factory validates the already typed domain object. Persistence and
  // transport boundaries validate unknown input before constructing Account.
  static validate(account: Account): Either<AccountValidationError, Account> {
    if (!isUUIDv7(account.id)) return left("account_invalid_uuid")
    if (!account.displayName.trim()) return left("account_display_name_empty")
    if (account.displayName.length > MAX_ACCOUNT_DISPLAY_NAME_LENGTH) return left("account_display_name_too_long")
    if (account.status !== "active" && account.status !== "disabled") return left("account_invalid_status")
    if (account.createdAt > account.updatedAt) return left("account_update_before_create")
    return right(account)
  }
}
