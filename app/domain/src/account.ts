import {Either, left, right} from "fp-ts/Either"
import {isUUIDv7} from "@utils"

export type AccountStatus = "active" | "disabled"

// TODO: Document what an account represent in our platform.
export interface Account {
  readonly id: string
  readonly displayName: string
  // TODO: Why email is optional ?
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
  static validate(account: Account): Either<AccountValidationError, Account> {
    if (!isUUIDv7(account.id)) return left("account_invalid_uuid")
    if (!account.displayName.trim()) return left("account_display_name_empty")
    // TODO: Define a constnat for the MAX length
    if (account.displayName.length > 255) return left("account_display_name_too_long")
    if (account.status !== "active" && account.status !== "disabled") return left("account_invalid_status")
    if (account.createdAt > account.updatedAt) return left("account_update_before_create")
    return right(account)
  }
}
