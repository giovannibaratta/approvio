import {Either, left, right} from "fp-ts/Either"
import {Brand, brand, isEmail, isObject, isUUIDv7} from "@utils"

export type AccountStatus = "active" | "disabled"
const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 255

declare const AccountBrand: unique symbol

export interface AccountData {
  readonly id: string
  readonly displayName: string
  /** Verified email asserted by the identity provider and required for authentication. */
  readonly profileEmail: string
  readonly status: AccountStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Platform login identity. It is not an organization principal: each
 * organization resolves this account to a separate local membership/user.
 */
export type Account = Brand<AccountData, typeof AccountBrand>

export type AccountValidationError =
  | "account_malformed_object"
  | "account_invalid_uuid"
  | "account_display_name_empty"
  | "account_display_name_too_long"
  | "account_invalid_profile_email"
  | "account_invalid_status"
  | "account_update_before_create"

export class AccountFactory {
  static validate(data: unknown): Either<AccountValidationError, Account> {
    if (!isObject(data)) return left("account_malformed_object")

    if (typeof data.id !== "string" || !isUUIDv7(data.id)) return left("account_invalid_uuid")
    if (typeof data.displayName !== "string") return left("account_display_name_empty")

    const displayName = data.displayName.trim()
    if (!displayName) return left("account_display_name_empty")
    if (displayName.length > MAX_ACCOUNT_DISPLAY_NAME_LENGTH) return left("account_display_name_too_long")

    if (typeof data.profileEmail !== "string" || !isEmail(data.profileEmail)) return left("account_invalid_profile_email")
    if (data.status !== "active" && data.status !== "disabled") return left("account_invalid_status")
    if (!(data.createdAt instanceof Date) || !(data.updatedAt instanceof Date)) return left("account_malformed_object")
    if (data.createdAt > data.updatedAt) return left("account_update_before_create")

    const accountData = {
      id: data.id,
      displayName,
      profileEmail: data.profileEmail,
      status: data.status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    } satisfies AccountData

    return right(brand<AccountData, typeof AccountBrand>(accountData))
  }
}
