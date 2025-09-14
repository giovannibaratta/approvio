import {
  OrganizationAdmin as OrganizationAdminApi,
  OrganizationAdminCreate,
  OrganizationAdminRemove,
  Pagination as PaginationApi
} from "@approvio/api"
import {AuthenticatedEntity, OrganizationAdmin} from "@domain"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException
} from "@nestjs/common"
import {
  AuthorizationError,
  AddOrganizationAdminRequest,
  ListOrganizationAdminsRequest,
  RemoveOrganizationAdminRequest,
  PaginatedOrganizationAdminsList,
  OrganizationAdminCreateError,
  OrganizationAdminListError,
  OrganizationAdminRemoveError
} from "@services"
import {Either, right, left, bindW, map} from "fp-ts/Either"
import {Do} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {generateErrorPayload} from "../error"

export function addOrganizationAdminApiToServiceModel(data: {
  organizationName: string
  adminData: OrganizationAdminCreate
  requestor: AuthenticatedEntity
}): Either<never, AddOrganizationAdminRequest> {
  return right({
    organizationName: data.organizationName,
    email: data.adminData.email,
    requestor: data.requestor
  })
}

export function listOrganizationAdminsApiToServiceModel(data: {
  organizationName: string
  page?: string
  limit?: string
}): Either<"invalid_number_format", ListOrganizationAdminsRequest> {
  const parseNumber = (value: string | undefined): Either<"invalid_number_format", number | undefined> => {
    if (value === undefined) return right(undefined)
    const parsed = parseInt(value, 10)
    if (isNaN(parsed)) return left("invalid_number_format" as const)
    return right(parsed)
  }

  return pipe(
    Do,
    bindW("organizationName", () => right(data.organizationName)),
    bindW("page", () => parseNumber(data.page)),
    bindW("limit", () => parseNumber(data.limit)),
    map(({organizationName, page, limit}) => ({organizationName, page, limit}))
  )
}

export function removeOrganizationAdminApiToServiceModel(data: {
  organizationName: string
  removeData: OrganizationAdminRemove
  requestor: AuthenticatedEntity
}): Either<never, RemoveOrganizationAdminRequest> {
  return right({
    organizationName: data.organizationName,
    identifier: data.removeData.userId,
    requestor: data.requestor
  })
}

export function mapOrganizationAdminToApi(admin: OrganizationAdmin): OrganizationAdminApi {
  return {
    userId: admin.id,
    email: admin.email,
    createdAt: admin.createdAt.toISOString()
  }
}

export function mapOrganizationAdminsToApi(adminsList: PaginatedOrganizationAdminsList): {
  data: OrganizationAdminApi[]
  pagination: PaginationApi
} {
  return {
    data: adminsList.admins.map(mapOrganizationAdminToApi),
    pagination: {
      total: adminsList.total,
      page: adminsList.page,
      limit: adminsList.limit
    }
  }
}

export function generateErrorResponseForAddOrganizationAdmin(
  error: OrganizationAdminCreateError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid admin email`))
    case "organization_admin_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: Admin with this email already exists`))
    case "organization_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Organization not found`))
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: User with this email not found`))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "organization_admin_invalid_uuid":
    case "unknown_error":
      Logger.error(`Internal server error in ${context}`, {errorCode: error})
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForListOrganizationAdmins(
  error: OrganizationAdminListError | "invalid_number_format",
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "organization_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Organization not found`))
    case "invalid_number_format":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Page and limit must be valid numbers`)
      )
    case "invalid_page_number":
    case "invalid_limit_number":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: Invalid pagination parameters`))
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
    case "organization_admin_invalid_uuid":
    case "unknown_error":
      Logger.error(`Internal server error in ${context}`, {errorCode: error})
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}

export function generateErrorResponseForRemoveOrganizationAdmin(
  error: OrganizationAdminRemoveError | AuthorizationError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "organization_not_found":
    case "organization_admin_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, `${context}: Organization admin not found`))
    case "invalid_identifier_format":
      return new BadRequestException(
        generateErrorPayload(errorCode, `${context}: Identifier must be a valid UUID or email address`)
      )
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, `${context}: You are not authorized to perform this action`)
      )
    case "unknown_error":
      Logger.error(`Internal server error in ${context}`, {errorCode: error})
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: An unexpected error occurred`)
      )
  }
}
