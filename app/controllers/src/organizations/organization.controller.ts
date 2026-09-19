import {OrganizationEntitlementsResponse, OrganizationSummary, OrganizationUsageResponse} from "@approvio/api"
import {Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Patch, Post, Query, Res} from "@nestjs/common"
import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {
  FeatureGateService,
  OrganizationLifecycleService,
  OrganizationService,
  QuotaService,
  UsageMeteringService
} from "@services"
import {AuthenticatedEntity, TenantContext} from "@domain"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {logSuccess} from "@utils"
import {ConfigProvider} from "@external/config"
import {Response} from "express"
import {OrganizationAdmission} from "@app/auth/tenant.guard"
import {createEntityTag, parseEntityTag} from "../etag"
import {
  generateErrorResponseForGetOrganization,
  generateErrorResponseForOrganizationMutation,
  mapOrganizationToApiResponse,
  validateOrganizationUpdate,
  generateErrorResponseForGetEntitlements,
  generateErrorResponseForGetUsage,
  mapEntitlementsToApiResponse,
  mapUsageSummaryToApiResponse,
  validateUsageQuery
} from "./organization.mappers"

export const ORGANIZATION_TENANT_ENDPOINT_ROOT = "o/:organizationId"

@Controller(ORGANIZATION_TENANT_ENDPOINT_ROOT)
export class OrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly lifecycleService: OrganizationLifecycleService,
    private readonly featureGateService: FeatureGateService,
    private readonly quotaService: QuotaService,
    private readonly usageMeteringService: UsageMeteringService,
    configProvider: ConfigProvider
  ) {
    this.etagSecret = configProvider.jwtConfig.secret
  }

  private readonly etagSecret: string

  @Get()
  @OrganizationAdmission("get_organization")
  @HttpCode(HttpStatus.OK)
  async getOrganization(
    @GetTenantContext() context: TenantContext,
    @Res({passthrough: true}) response: Response
  ): Promise<OrganizationSummary> {
    const result = await pipe(
      this.organizationService.getTenantOrganization(context),
      TE.bindTo("organization"),
      TE.bindW("apiResponse", ({organization}) => TE.fromEither(mapOrganizationToApiResponse(organization))),
      TE.map(({organization, apiResponse}) =>
        this.setETagAndReturnSummary(context, response, {...apiResponse, occ: organization.occ})
      )
    )()

    if (isLeft(result)) throw generateErrorResponseForGetOrganization(result.left)

    return result.right
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateOrganization(
    @Body() body: unknown,
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<OrganizationSummary> {
    const result = await pipe(
      validateOrganizationUpdate(body),
      TE.fromEither,
      TE.bindW("version", () =>
        TE.fromEither(parseEntityTag(this.etagSecret, context.organizationId, context.organizationId, ifMatch))
      ),
      TE.chainW(({displayName, version}) =>
        this.organizationService.update(context, requestor, version, {displayName})
      ),
      TE.map(organization => this.setETagAndReturnSummary(context, response, organization))
    )()

    if (isLeft(result)) throw generateErrorResponseForOrganizationMutation(result.left)

    return result.right
  }

  @Post("suspend")
  @HttpCode(HttpStatus.OK)
  async suspendOrganization(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<OrganizationSummary> {
    const result = await pipe(
      parseEntityTag(this.etagSecret, context.organizationId, context.organizationId, ifMatch),
      TE.fromEither,
      TE.chainW(expectedVersion => this.lifecycleService.suspend(context, requestor, expectedVersion)),
      TE.map(organization => this.setETagAndReturnSummary(context, response, organization))
    )()

    if (isLeft(result)) throw generateErrorResponseForOrganizationMutation(result.left)

    return result.right
  }

  @Post("resume")
  @OrganizationAdmission("resume_organization")
  @HttpCode(HttpStatus.OK)
  async resumeOrganization(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<OrganizationSummary> {
    const result = await pipe(
      parseEntityTag(this.etagSecret, context.organizationId, context.organizationId, ifMatch),
      TE.fromEither,
      TE.chainW(expectedVersion => this.lifecycleService.resume(context, requestor, expectedVersion)),
      TE.map(organization => this.setETagAndReturnSummary(context, response, organization))
    )()

    if (isLeft(result)) throw generateErrorResponseForOrganizationMutation(result.left)

    return result.right
  }

  @Delete()
  @OrganizationAdmission("delete_organization")
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteOrganization(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) response: Response
  ): Promise<OrganizationSummary> {
    const result = await pipe(
      parseEntityTag(this.etagSecret, context.organizationId, context.organizationId, ifMatch),
      TE.fromEither,
      TE.chainW(expectedVersion => this.lifecycleService.requestDeletion(context, requestor, expectedVersion)),
      TE.map(organization => this.setETagAndReturnSummary(context, response, organization))
    )()

    if (isLeft(result)) throw generateErrorResponseForOrganizationMutation(result.left)

    return result.right
  }

  private setETagAndReturnSummary(
    context: TenantContext,
    response: Response,
    organization: OrganizationSummary & {readonly occ: bigint}
  ): OrganizationSummary {
    response.setHeader(
      "ETag",
      createEntityTag(this.etagSecret, context.organizationId, context.organizationId, organization.occ)
    )
    return {
      id: organization.id,
      slug: organization.slug,
      displayName: organization.displayName,
      status: organization.status
    }
  }

  @Get("entitlements")
  @HttpCode(HttpStatus.OK)
  async getOrganizationEntitlements(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<OrganizationEntitlementsResponse> {
    const eitherResult = await pipe(
      TE.Do,
      TE.bindW("entitlements", () => this.featureGateService.getEffectiveEntitlements(context)),
      TE.bindW("quotas", () => this.quotaService.getAllEffectiveQuotas(requestor, context)),
      TE.chainW(({entitlements, quotas}) =>
        TE.fromEither(mapEntitlementsToApiResponse(context.organizationId, entitlements, quotas))
      ),
      logSuccess("Organization entitlements retrieved", "OrganizationController", () => ({
        organizationId: context.organizationId
      }))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetEntitlements(eitherResult.left)

    return eitherResult.right
  }

  @Get("usage")
  @HttpCode(HttpStatus.OK)
  async getOrganizationUsage(
    @GetTenantContext() context: TenantContext,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query("period") period?: string,
    @Query("metric") metric?: string
  ): Promise<OrganizationUsageResponse> {
    const eitherResult = await pipe(
      TE.fromEither(validateUsageQuery(period, metric)),
      TE.chainW(query =>
        this.usageMeteringService.getOrganizationUsage(requestor, context, query.period, query.metricFilter)
      ),
      TE.chainW(summary => TE.fromEither(mapUsageSummaryToApiResponse(summary))),
      logSuccess("Organization usage retrieved", "OrganizationController", () => ({
        organizationId: context.organizationId,
        period,
        metric
      }))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetUsage(eitherResult.left)

    return eitherResult.right
  }
}
