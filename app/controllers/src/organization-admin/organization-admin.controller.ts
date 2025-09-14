import {
  OrganizationAdmin as OrganizationAdminApi,
  OrganizationAdminCreate,
  OrganizationAdminRemove,
  Pagination as PaginationApi
} from "@approvio/api"
import {Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res} from "@nestjs/common"
import {OrganizationAdminService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  addOrganizationAdminApiToServiceModel,
  listOrganizationAdminsApiToServiceModel,
  removeOrganizationAdminApiToServiceModel,
  mapOrganizationAdminsToApi,
  generateErrorResponseForAddOrganizationAdmin,
  generateErrorResponseForListOrganizationAdmins,
  generateErrorResponseForRemoveOrganizationAdmin
} from "./organization-admin.mappers"
import {GetAuthenticatedEntity} from "@app/auth"
import {AuthenticatedEntity} from "@domain"

export const ORGANIZATION_ADMIN_ENDPOINT_ROOT = "organization"

@Controller(ORGANIZATION_ADMIN_ENDPOINT_ROOT)
export class OrganizationAdminController {
  constructor(private readonly organizationAdminService: OrganizationAdminService) {}

  @Post(":organizationName/admins")
  @HttpCode(HttpStatus.CREATED)
  async addOrganizationAdmin(
    @Param("organizationName") organizationName: string,
    @Body() request: OrganizationAdminCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // Wrap service call in lambda to preserve "this" context
    const serviceAddAdmin = (req: Parameters<OrganizationAdminService["addOrganizationAdmin"]>[0]) =>
      this.organizationAdminService.addOrganizationAdmin(req)

    const eitherAdminId = await pipe(
      {organizationName, adminData: request, requestor},
      addOrganizationAdminApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceAddAdmin),
      TE.map(data => data.id)
    )()

    if (isLeft(eitherAdminId))
      throw generateErrorResponseForAddOrganizationAdmin(eitherAdminId.left, "Failed to add organization admin")

    const adminId = eitherAdminId.right
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${adminId}`
    response.setHeader("Location", location)
  }

  @Get(":organizationName/admins")
  async listOrganizationAdmins(
    @Param("organizationName") organizationName: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string
  ): Promise<{data: OrganizationAdminApi[]; pagination: PaginationApi}> {
    // Wrap service call in lambda to preserve "this" context
    const serviceListAdmins = (req: Parameters<OrganizationAdminService["listOrganizationAdmins"]>[0]) =>
      this.organizationAdminService.listOrganizationAdmins(req)

    const eitherAdminsList = await pipe(
      {organizationName, page, limit},
      listOrganizationAdminsApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceListAdmins)
    )()

    if (isLeft(eitherAdminsList))
      throw generateErrorResponseForListOrganizationAdmins(eitherAdminsList.left, "Failed to list organization admins")

    return mapOrganizationAdminsToApi(eitherAdminsList.right)
  }

  @Delete(":organizationName/admins")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOrganizationAdmin(
    @Param("organizationName") organizationName: string,
    @Body() request: OrganizationAdminRemove,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // Wrap service call in lambda to preserve "this" context
    const serviceRemoveAdmin = (req: Parameters<OrganizationAdminService["removeOrganizationAdmin"]>[0]) =>
      this.organizationAdminService.removeOrganizationAdmin(req)

    const eitherResult = await pipe(
      {organizationName, removeData: request, requestor},
      removeOrganizationAdminApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceRemoveAdmin)
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForRemoveOrganizationAdmin(eitherResult.left, "Failed to remove organization admin")
  }
}
