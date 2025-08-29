import {OrganizationAdmin, OrganizationAdminFactory} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {User} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {isUUIDv4, isEmail} from "@utils"
import {
  ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
  OrganizationAdminCreateError,
  OrganizationAdminListError,
  OrganizationAdminRemoveError,
  OrganizationAdminRepository,
  PaginatedOrganizationAdminsList
} from "./interfaces"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"

const MIN_PAGE = 1
const MIN_LIMIT = 1
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

const SUPPORTED_ORGANIZATION = "default"

@Injectable()
export class OrganizationAdminService {
  constructor(
    @Inject(ORGANIZATION_ADMIN_REPOSITORY_TOKEN)
    private readonly orgAdminRepo: OrganizationAdminRepository
  ) {}

  addOrganizationAdmin(
    request: AddOrganizationAdminRequest
  ): TaskEither<OrganizationAdminCreateError | AuthorizationError, OrganizationAdmin> {
    // Wrap repository call in a lambda to preserve "this" context
    const persistAdmin = (admin: OrganizationAdmin) => this.orgAdminRepo.createOrganizationAdmin(admin)

    const validateRequest = (req: AddOrganizationAdminRequest, requestor: User) => {
      if (requestor.orgRole !== "admin") return E.left("requestor_not_authorized" as const)
      if (req.organizationName !== SUPPORTED_ORGANIZATION) return E.left("organization_not_found" as const)

      return OrganizationAdminFactory.newOrganizationAdmin({email: req.email})
    }

    return pipe(
      validateUserEntity(request.requestor),
      E.chainW(requestor => validateRequest(request, requestor)),
      TE.fromEither,
      TE.chainW(persistAdmin)
    )
  }

  listOrganizationAdmins(
    request: ListOrganizationAdminsRequest
  ): TaskEither<OrganizationAdminListError, PaginatedOrganizationAdminsList> {
    const validateRequest = (req: ListOrganizationAdminsRequest) => {
      if (req.organizationName !== SUPPORTED_ORGANIZATION) return E.left("organization_not_found" as const)

      const page = req.page ?? 1
      const limit = req.limit ?? DEFAULT_LIMIT

      if (page < MIN_PAGE) return E.left("invalid_page_number" as const)
      if (limit < MIN_LIMIT || limit > MAX_LIMIT) return E.left("invalid_limit_number" as const)

      return E.right({organizationName: req.organizationName, page, limit})
    }

    // Wrap repository call in a lambda to preserve "this" context
    const fetchAdmins = (params: {page: number; limit: number}) =>
      this.orgAdminRepo.listOrganizationAdmins({
        page: params.page,
        limit: params.limit
      })

    return pipe(request, validateRequest, TE.fromEither, TE.chainW(fetchAdmins))
  }

  removeOrganizationAdmin(
    request: RemoveOrganizationAdminRequest
  ): TaskEither<OrganizationAdminRemoveError | AuthorizationError, void> {
    const validateRequest = (req: RemoveOrganizationAdminRequest, requestor: User) => {
      if (requestor.orgRole !== "admin") return E.left("requestor_not_authorized" as const)
      if (req.organizationName !== SUPPORTED_ORGANIZATION) return E.left("organization_not_found" as const)

      return E.right(req)
    }

    // Wrap repository calls in lambdas to preserve "this" context and discriminate identifier type
    const removeAdmin = (req: RemoveOrganizationAdminRequest) => {
      if (isUUIDv4(req.identifier)) return this.orgAdminRepo.removeOrganizationAdmin(req.identifier)

      if (isEmail(req.identifier)) return this.orgAdminRepo.removeOrganizationAdminByEmail(req.identifier)

      return TE.left("invalid_identifier_format" as const)
    }

    return pipe(
      validateUserEntity(request.requestor),
      E.chainW(requestor => validateRequest(request, requestor)),
      TE.fromEither,
      TE.chainW(() => removeAdmin(request))
    )
  }
}

export interface AddOrganizationAdminRequest extends RequestorAwareRequest {
  readonly organizationName: string
  readonly email: string
}

export interface ListOrganizationAdminsRequest {
  readonly organizationName: string
  readonly page?: number
  readonly limit?: number
}

export interface RemoveOrganizationAdminRequest extends RequestorAwareRequest {
  readonly organizationName: string
  readonly identifier: string
}
