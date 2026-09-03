import {
  MetricUsageItem,
  OrganizationEntitlementsResponse,
  OrganizationUsageResponse,
  validateOrganizationEntitlementsResponse,
  validateOrganizationUsageResponse
} from "@approvio/api"
import {isUsageMetric, parseBillingPeriod, SupportedQuotaType, TierQuotaLimit, UsageMetric} from "@domain"
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import {EffectiveEntitlements, EffectiveQuotasError, OrganizationUsageSummary, UsageMeteringError} from "@services"
import {generateErrorPayload} from "../error"
import {isUUIDv7} from "@utils"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

export type GetEntitlementsError = "invalid_org_id" | "malformed_response" | "unknown_error" | EffectiveQuotasError

export type GetUsageError =
  "invalid_org_id" | "invalid_period" | "invalid_metric" | "malformed_response" | UsageMeteringError

export function validateOrgId(orgId: string): E.Either<"invalid_org_id", string> {
  if (!isUUIDv7(orgId)) return E.left("invalid_org_id")

  return E.right(orgId)
}

export function validateUsageQuery(
  period?: string,
  metric?: string
): E.Either<"invalid_period" | "invalid_metric", {period?: string; metricFilter?: UsageMetric}> {
  if (period !== undefined) {
    const parseResult = parseBillingPeriod(period)
    if (E.isLeft(parseResult)) return E.left("invalid_period")
  }

  let metricFilter: UsageMetric | undefined
  if (metric !== undefined) {
    if (!isUsageMetric(metric)) return E.left("invalid_metric")
    metricFilter = metric
  }

  return E.right({period, metricFilter})
}

export function mapEntitlementsToApiResponse(
  orgId: string,
  entitlements: EffectiveEntitlements,
  quotas: Record<SupportedQuotaType, TierQuotaLimit>
): E.Either<"malformed_response", OrganizationEntitlementsResponse> {
  const mappedQuotas: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(quotas)) mappedQuotas[k] = v === "UNLIMITED" ? null : v

  const payload = {
    orgId,
    planTier: entitlements.planTier,
    edition: entitlements.edition,
    features: entitlements.features,
    quotas: mappedQuotas
  }

  return pipe(
    validateOrganizationEntitlementsResponse(payload),
    E.mapLeft((): "malformed_response" => "malformed_response")
  )
}

export function mapUsageSummaryToApiResponse(
  summary: OrganizationUsageSummary
): E.Either<"malformed_response", OrganizationUsageResponse> {
  const payload = {
    orgId: summary.orgId,
    period: summary.period,
    periodStartsAt: summary.periodStartsAt.toISOString(),
    periodEndsAt: summary.periodEndsAt.toISOString(),
    metrics: summary.metrics.map((m): MetricUsageItem => ({
      metric: m.metric,
      limit: m.limit === "UNLIMITED" ? null : m.limit,
      consumed: m.consumed,
      reserved: m.reserved,
      remaining: m.remaining === "UNLIMITED" ? null : m.remaining,
      unit: m.unit
    }))
  }

  return pipe(
    validateOrganizationUsageResponse(payload),
    E.mapLeft((): "malformed_response" => "malformed_response")
  )
}

export function generateErrorResponseForGetEntitlements(error: GetEntitlementsError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_org_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid organization UUID format"))
    case "invalid_page":
    case "invalid_limit":
    case "quota_invalid_limit":
    case "quota_invalid_id":
    case "quota_malformed_quota":
    case "quota_invalid_scope":
    case "quota_invalid_quota_type":
    case "quota_missing_target_id":
    case "quota_invalid_target_id":
    case "quota_missing_configuration":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid parameters"))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, "Requestor is not authorized to perform this operation")
      )
    case "quota_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Organization not found"))
    case "quota_unknown_error":
    case "quota_unsupported_node_type":
    case "malformed_response":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("INTERNAL_SERVER_ERROR", "Internal server error"))
  }
}

export function generateErrorResponseForGetUsage(error: GetUsageError): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "invalid_org_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid organization UUID format"))
    case "invalid_period":
    case "billing_period_invalid_format":
    case "billing_period_invalid_month":
    case "billing_period_invalid_year":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid billing period format. Expected YYYY-MM"))
    case "invalid_metric":
      return new BadRequestException(generateErrorPayload(errorCode, "Unsupported usage metric"))
    case "quota_exceeded":
    case "quota_missing_configuration":
      return new BadRequestException(generateErrorPayload(errorCode, "Quota error"))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, "Requestor is not authorized to perform this operation")
      )
    case "organization_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Organization not found"))
    case "malformed_response":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("INTERNAL_SERVER_ERROR", "Internal server error"))
  }
}
