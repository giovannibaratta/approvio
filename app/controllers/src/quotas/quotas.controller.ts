import {Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus} from "@nestjs/common"
import {
  QuotaUpdate,
  validateListQuotasParams,
  validateQuotaUpdate,
  validateQuotaCreate,
  ListQuotasParams
} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {AuthenticatedEntity, NodeType} from "@domain"
import {DEFAULT_ORG_ID, QuotaService} from "@services"
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

@Controller(QUOTAS_ENDPOINT_ROOT)
export class QuotasController {
  constructor(private readonly quotaService: QuotaService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createQuota(@GetAuthenticatedEntity() requestor: AuthenticatedEntity, @Body() request: unknown) {
    const eitherResult = await pipe(
      request,
      validateQuotaCreate,
      E.map(mapToCreateQuotaRequest),
      TE.fromEither,
      TE.chainW(validatedRequest =>
        this.quotaService.createQuota(requestor, {
          ...validatedRequest,
          nodeIdentifier: validatedRequest.nodeType === "Org" ? DEFAULT_ORG_ID : validatedRequest.nodeIdentifier
        })
      ),
      logSuccess("Quota created", "QuotasController", quota => ({id: quota.id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForCreateQuota(eitherResult.left)

    return mapQuotaToApi(eitherResult.right)
  }

  @Get()
  async listQuotas(@Query() query: Record<string, unknown>) {
    const eitherResult = await pipe(
      query,
      validateListQuotasParams,
      TE.fromEither,
      TE.chainW((validatedQuery: ListQuotasParams) =>
        this.quotaService.listQuotas(validatedQuery.page ?? 1, validatedQuery.limit ?? 20, {
          nodeType: validatedQuery.scope as NodeType | undefined,
          quotaType: validatedQuery.quotaType,
          nodeIdentifier: validatedQuery.scope === "Org" ? DEFAULT_ORG_ID : validatedQuery.targetId
        })
      ),
      TE.map(mapListQuotasResultToApi),
      logSuccess("Quotas listed", "QuotasController")
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForListQuotas(eitherResult.left)

    return eitherResult.right
  }

  @Get(":id")
  async getQuota(@Param("id") id: string) {
    const eitherResult = await pipe(
      this.quotaService.getQuotaById(id),
      TE.map(mapQuotaToApi),
      logSuccess("Quota retrieved", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForGetQuota(eitherResult.left)

    return eitherResult.right
  }

  @Patch(":id")
  async patchQuota(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Param("id") id: string,
    @Body() request: QuotaUpdate
  ) {
    const eitherResult = await pipe(
      request,
      validateQuotaUpdate,
      TE.fromEither,
      TE.chainW(validatedRequest => this.quotaService.updateQuota(requestor, id, validatedRequest.limit)),
      TE.map(mapQuotaToApi),
      logSuccess("Quota updated", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForUpdateQuota(eitherResult.left)

    return eitherResult.right
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteQuota(@GetAuthenticatedEntity() requestor: AuthenticatedEntity, @Param("id") id: string) {
    const eitherResult = await pipe(
      this.quotaService.deleteQuota(requestor, id),
      logSuccess("Quota deleted", "QuotasController", () => ({id}))
    )()

    if (isLeft(eitherResult)) throw generateErrorResponseForDeleteQuota(eitherResult.left)
  }
}
