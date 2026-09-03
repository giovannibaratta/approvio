import {OrganizationEntitlementsResponse, OrganizationUsageResponse} from "@approvio/api"
import {Controller, Get, HttpCode, HttpStatus, Param, Query} from "@nestjs/common"
import {FeatureGateService, QuotaService, UsageMeteringService} from "@services"
import {GetAuthenticatedEntity} from "@app/auth"
import {AuthenticatedEntity} from "@domain"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {logSuccess} from "@utils"
import {
  generateErrorResponseForGetEntitlements,
  generateErrorResponseForGetUsage,
  mapEntitlementsToApiResponse,
  mapUsageSummaryToApiResponse,
  validateOrgId,
  validateUsageQuery
} from "./organization.mappers"

export const ORGANIZATIONS_ENDPOINT_ROOT = "organizations"

@Controller(ORGANIZATIONS_ENDPOINT_ROOT)
export class OrganizationController {
  constructor(
    private readonly featureGateService: FeatureGateService,
    private readonly quotaService: QuotaService,
    private readonly usageMeteringService: UsageMeteringService
  ) {}

  @Get(":orgId/entitlements")
  @HttpCode(HttpStatus.OK)
  async getOrganizationEntitlements(
    @Param("orgId") orgId: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<OrganizationEntitlementsResponse> {
    const eitherResult = await pipe(
      validateOrgId(orgId),
      TE.fromEither,
      TE.bindTo("validatedOrgId"),
      TE.bindW("entitlements", ({validatedOrgId}) => this.featureGateService.getEffectiveEntitlements(validatedOrgId)),
      TE.bindW("quotas", ({validatedOrgId}) => this.quotaService.getAllEffectiveQuotas(requestor, validatedOrgId)),
      TE.chainW(({validatedOrgId, entitlements, quotas}) =>
        TE.fromEither(mapEntitlementsToApiResponse(validatedOrgId, entitlements, quotas))
      ),
      logSuccess("Organization entitlements retrieved", "OrganizationController", () => ({orgId}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetEntitlements(eitherResult.left)

    return eitherResult.right
  }

  @Get(":orgId/usage")
  @HttpCode(HttpStatus.OK)
  async getOrganizationUsage(
    @Param("orgId") orgId: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Query("period") period?: string,
    @Query("metric") metric?: string
  ): Promise<OrganizationUsageResponse> {
    const eitherResult = await pipe(
      validateOrgId(orgId),
      TE.fromEither,
      TE.bindTo("validatedOrgId"),
      TE.bindW("query", () => TE.fromEither(validateUsageQuery(period, metric))),
      TE.chainW(({validatedOrgId, query}) =>
        this.usageMeteringService.getOrganizationUsage(requestor, validatedOrgId, query.period, query.metricFilter)
      ),
      TE.chainW(summary => TE.fromEither(mapUsageSummaryToApiResponse(summary))),
      logSuccess("Organization usage retrieved", "OrganizationController", () => ({orgId, period, metric}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetUsage(eitherResult.left)

    return eitherResult.right
  }
}
