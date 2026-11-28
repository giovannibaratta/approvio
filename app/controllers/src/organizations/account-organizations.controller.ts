import {
  OrganizationCreateResponse,
  OrganizationList,
  validateOrganizationCreate,
  validateSharedListParams
} from "@approvio/api"
import {GetBrowserSession, GetPlatformSession} from "@app/auth"
import {AuthenticatedBrowserSession, AuthenticatedPlatformSession} from "@domain"
import {Body, Controller, Get, HttpCode, HttpStatus, Post, Query} from "@nestjs/common"
import {AuthService, OrganizationService} from "@services"
import {isLeft} from "fp-ts/Either"
import {
  generateErrorResponseForCreateOrganization,
  generateErrorResponseForListAccountOrganizations,
  mapOrganizationCreationToApiResponse,
  mapOrganizationListToApiResponse
} from "./account-organizations.mappers"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"

@Controller("o")
export class AccountOrganizationsController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly authService: AuthService
  ) {}

  private resolveAccount(session: AuthenticatedBrowserSession) {
    return pipe(
      this.authService.getOwnAccount(session),
      TE.mapLeft(error =>
        error === "account_not_found" ? ("permission_denied" as const) : ("repository_dependency_error" as const)
      )
    )
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async listAccountOrganizations(
    @GetBrowserSession() session: AuthenticatedBrowserSession,
    @Query("page") pageValue?: string,
    @Query("limit") limitValue?: string
  ): Promise<OrganizationList> {
    const result = await pipe(
      validateSharedListParams({page: pageValue, limit: limitValue}),
      TE.fromEither,
      TE.chainW(({page, limit}) =>
        pipe(
          this.resolveAccount(session),
          TE.chainW(account => this.organizationService.listOrganizationsForAccount(account, page, limit))
        )
      ),
      TE.map(mapOrganizationListToApiResponse)
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
