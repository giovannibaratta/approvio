import {Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus} from "@nestjs/common"
import {
  QuotaUpdate,
  validateListQuotasParams,
  validateQuotaUpdate,
  validateQuotaCreate,
  ListQuotasParams
} from "@approvio/api"
import {GetAuthenticatedEntity, GetTenantContext} from "@app/auth"
import {AuthenticatedEntity, TenantContext} from "@domain"
import {QuotaService} from "@services"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {isLeft} from "fp-ts/Either"
import {logSuccess} from "@utils"

import {
  mapQuotaToApi,
  mapToCreateQuotaRequest,
  mapListQuotasResultToApi,
  generateErrorResponseForGetQuota,
  generateErrorResponseForCreateQuota,
  generateErrorResponseForUpdateQuota,
  generateErrorResponseForDeleteQuota,
  generateErrorResponseForListQuotas
} from "./quotas.mappers"

export const QUOTAS_ENDPOINT_ROOT = "quotas"

@Controller(`o/:organizationId/${QUOTAS_ENDPOINT_ROOT}`)
export class QuotasController {
  constructor(private readonly quotaService: QuotaService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createQuota(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Body() request: unknown
  ) {
    const eitherResult = await pipe(
      request,
      validateQuotaCreate,
      E.map(mapToCreateQuotaRequest),
      TE.fromEither,
      TE.chainW(validatedRequest =>
        this.quotaService.createQuota(requestor, context, {
          ...validatedRequest,
          nodeIdentifier: validatedRequest.nodeIdentifier
        })
      ),
      logSuccess("Quota created", "QuotasController", quota => ({id: quota.id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForCreateQuota(eitherResult.left)

    return mapQuotaToApi(eitherResult.right)
  }

  @Get()
  async listQuotas(@Query() query: Record<string, unknown>, @GetTenantContext() context: TenantContext) {
    const eitherResult = await pipe(
      query,
      validateListQuotasParams,
      TE.fromEither,
      TE.chainW((validatedQuery: ListQuotasParams) =>
        this.quotaService.listQuotas(validatedQuery.page ?? 1, validatedQuery.limit ?? 20, context, {
          nodeType: validatedQuery.scope,
          quotaType: validatedQuery.quotaType,
          nodeIdentifier: validatedQuery.targetId
        })
      ),
      TE.map(mapListQuotasResultToApi),
      logSuccess("Quotas listed", "QuotasController")
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForListQuotas(eitherResult.left)

    return eitherResult.right
  }

  @Get(":id")
  async getQuota(@Param("id") id: string, @GetTenantContext() context: TenantContext) {
    const eitherResult = await pipe(
      this.quotaService.getQuotaById(context, id),
      TE.map(mapQuotaToApi),
      logSuccess("Quota retrieved", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetQuota(eitherResult.left)

    return eitherResult.right
  }

  @Patch(":id")
  async patchQuota(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Param("id") id: string,
    @Body() request: QuotaUpdate
  ) {
    const eitherResult = await pipe(
      request,
      validateQuotaUpdate,
      TE.fromEither,
      TE.chainW(validatedRequest => this.quotaService.updateQuota(requestor, context, id, validatedRequest.limit)),
      TE.map(mapQuotaToApi),
      logSuccess("Quota updated", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForUpdateQuota(eitherResult.left)

    return eitherResult.right
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteQuota(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @GetTenantContext() context: TenantContext,
    @Param("id") id: string
  ) {
    const eitherResult = await pipe(
      this.quotaService.deleteQuota(requestor, context, id),
      logSuccess("Quota deleted", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForDeleteQuota(eitherResult.left)
  }
}
