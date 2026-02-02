import {OrganizationAdmin, OrganizationAdminValidationError} from "@domain"
import {AuthorizationError, UnknownError} from "@services/error"
import {TaskEither} from "fp-ts/TaskEither"

export type OrganizationAdminCreateError =
  | "user_not_found"
  | "organization_admin_already_exists"
  | "organization_not_found"
  | AuthorizationError
  | OrganizationAdminValidationError
  | UnknownError

export type OrganizationAdminGetError = "organization_not_found" | OrganizationAdminValidationError | UnknownError

export type OrganizationAdminListError =
  | "organization_not_found"
  | "invalid_page_number"
  | "invalid_limit_number"
  | OrganizationAdminValidationError
  | UnknownError

export type OrganizationAdminRemoveError =
  | "organization_not_found"
  | "organization_admin_not_found"
  | "invalid_identifier_format"
  | "organization_admin_is_last"
  | AuthorizationError
  | UnknownError

export interface PaginatedOrganizationAdminsList {
  readonly admins: ReadonlyArray<OrganizationAdmin>
  readonly page: number
  readonly limit: number
  readonly total: number
}

export const ORGANIZATION_ADMIN_REPOSITORY_TOKEN = "ORGANIZATION_ADMIN_REPOSITORY_TOKEN"

export interface OrganizationAdminRepository {
  createOrganizationAdmin(admin: OrganizationAdmin): TaskEither<OrganizationAdminCreateError, OrganizationAdmin>
  listOrganizationAdmins(
    params: ListOrganizationAdminsRepoRequest
  ): TaskEither<OrganizationAdminListError, PaginatedOrganizationAdminsList>
  removeOrganizationAdminIfNotLast(userId: string): TaskEither<OrganizationAdminRemoveError, void>
  removeOrganizationAdminByEmailIfNotLast(email: string): TaskEither<OrganizationAdminRemoveError, void>
}

export interface ListOrganizationAdminsRepoRequest {
  readonly page: number
  readonly limit: number
}
