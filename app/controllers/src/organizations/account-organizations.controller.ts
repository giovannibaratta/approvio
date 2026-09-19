import {OrganizationCreateResponse, OrganizationList, validateOrganizationCreate} from "@approvio/api"
import {GetPlatformSession} from "@app/auth"
import {AuthenticatedPlatformSession} from "@domain"
import {Body, Controller, Get, HttpCode, HttpStatus, Post, Query} from "@nestjs/common"
import {OrganizationService} from "@services"
import {isLeft} from "fp-ts/Either"
import {validateOrganizationPagination} from "./organization.mappers"
import {
  generateErrorResponseForCreateOrganization,
  generateErrorResponseForListAccountOrganizations,
  mapOrganizationCreationToApiResponse,
  mapOrganizationListToApiResponse
} from "./account-organizations.mappers"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"

@Controller("organizations")
export class AccountOrganizationsController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async listAccountOrganizations(
    @GetPlatformSession() session: AuthenticatedPlatformSession,
    @Query("page") pageValue?: string,
    @Query("limit") limitValue?: string
  ): Promise<OrganizationList> {
    const result = await pipe(
      validateOrganizationPagination(pageValue, limitValue),
      TE.fromEither,
      TE.bindW("organizations", ({page, limit}) => this.organizationService.listForAccount(session, page, limit)),
      TE.map(({organizations, page, limit}) => mapOrganizationListToApiResponse({...organizations, page, limit}))
    )()

    if (isLeft(result)) throw generateErrorResponseForListAccountOrganizations(result.left)

    return result.right
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrganization(
    @GetPlatformSession() session: AuthenticatedPlatformSession,
    @Body() body: unknown
  ): Promise<OrganizationCreateResponse> {
    const result = await pipe(
      validateOrganizationCreate(body),
      TE.fromEither,
      TE.chainW(request => this.organizationService.create(session, request)),
      TE.map(mapOrganizationCreationToApiResponse)
    )()

    if (isLeft(result)) throw generateErrorResponseForCreateOrganization(result.left)

    return result.right
  }
}
