import {
  MetricUsageItem,
  OrganizationEntitlementsResponse,
  OrganizationUsageResponse,
  OrganizationSummary,
  validateOrganizationSummary,
  validateOrganizationEntitlementsResponse,
  validateOrganizationUsageResponse
} from "@approvio/api"
import {
  OrganizationSummary as OrganizationModel,
  isUsageMetric,
  parseBillingPeriod,
  SupportedQuotaType,
  TierQuotaLimit,
  UsageMetric
} from "@domain"
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException
} from "@nestjs/common"
import {
  OrganizationGetError,
  OrganizationLifecycleError,
  OrganizationUpdateError,
  EffectiveEntitlements,
  EffectiveQuotasError,
  OrganizationUsageSummary,
  UsageMeteringError
} from "@services"
import {generateErrorPayload} from "../error"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"

export type GetEntitlementsError = "malformed_response" | "unknown_error" | EffectiveQuotasError

export type GetUsageError = "invalid_period" | "invalid_metric" | "malformed_response" | UsageMeteringError

export function parsePositiveInteger(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function validateOrganizationPagination(
  pageValue?: string,
  limitValue?: string
): E.Either<"invalid_pagination", {page: number; limit: number}> {
  const page = parsePositiveInteger(pageValue, 1)
  const limit = parsePositiveInteger(limitValue, 20)
  if (page === undefined || limit === undefined || limit > 100) return E.left("invalid_pagination")
  return E.right({page, limit})
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
    organizationId: orgId,
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
    organizationId: summary.organizationId,
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
    case "repository_dependency_error":
    case "quota_unsupported_node_type":
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "quota_invalid_organization_id":
    case "organization_not_found":
    case "malformed_response":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("INTERNAL_SERVER_ERROR", "Internal server error"))
  }
}

export function generateErrorResponseForGetUsage(error: GetUsageError): HttpException {
  if (typeof error === "object") {
    if (error.type === "cache_unavailable")
      return new ServiceUnavailableException(
        generateErrorPayload("QUOTA_CACHE_UNAVAILABLE", "Quota state is being rebuilt. Retry later")
      )
    return new InternalServerErrorException(generateErrorPayload("INTERNAL_SERVER_ERROR", "Internal server error"), {
      cause: error
    })
  }
  const errorCode = error.toUpperCase()

  switch (error) {
    case "quota_cache_unavailable":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, "Quota state is being rebuilt. Retry later")
      )
    case "invalid_period":
    case "billing_period_invalid_format":
    case "billing_period_invalid_month":
    case "billing_period_invalid_year":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid billing period format. Expected YYYY-MM"))
    case "invalid_metric":
      return new BadRequestException(generateErrorPayload(errorCode, "Unsupported usage metric"))
    case "invalid_operation_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid usage operation ID"))
    case "invalid_entity_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid usage entity ID"))
    case "invalid_actor_id":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid usage actor ID"))
    case "usage_operation_malformed_object":
    case "invalid_entity_type":
    case "invalid_actor":
    case "invalid_billable_flag":
      return new BadRequestException(generateErrorPayload(errorCode, "Invalid usage operation"))
    case "usage_settlement_malformed_object":
    case "usage_snapshot_malformed_object":
    case "invalid_consumed_units":
    case "invalid_revision":
    case "invalid_settlement_state":
    case "duplicate_usage_operation":
    case "usage_snapshot_quantity_overflow":
      return new InternalServerErrorException(generateErrorPayload(errorCode, "Invalid persisted usage data"))
    case "invalid_estimated_units":
      return new BadRequestException(
        generateErrorPayload(errorCode, "Estimated units must be a non-negative safe integer")
      )
    case "invalid_actual_units":
      return new BadRequestException(
        generateErrorPayload(errorCode, "Actual units must be a non-negative safe integer")
      )
    case "quota_exceeded":
    case "quota_missing_configuration":
      return new BadRequestException(generateErrorPayload(errorCode, "Quota error"))
    case "requestor_not_authorized":
      return new ForbiddenException(
        generateErrorPayload(errorCode, "Requestor is not authorized to perform this operation")
      )
    case "organization_not_found":
      return new NotFoundException(generateErrorPayload(errorCode, "Organization not found"))
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "operation_mismatch":
    case "invalid_transition":
    case "invalid_usage":
    case "invalid_batch_size":
    case "repository_dependency_error":
    case "event_not_found":
    case "tenant_event_malformed_object":
    case "tenant_event_organization_id_invalid":
    case "tenant_event_schema_version_invalid":
    case "tenant_event_event_id_invalid":
    case "tenant_event_type_invalid":
    case "tenant_event_task_id_invalid":
    case "tenant_event_task_kind_invalid":
    case "tenant_event_task_occ_invalid":
    case "tenant_event_workflow_id_invalid":
    case "tenant_event_workflow_occ_invalid":
    case "tenant_event_workflow_status_invalid":
    case "tenant_event_occurred_at_invalid":
    case "tenant_event_actor_malformed_object":
    case "tenant_event_actor_display_name_invalid":
    case "tenant_event_actor_type_invalid":
    case "tenant_event_actor_id_invalid":
    case "tenant_event_operation_id_invalid":
    case "tenant_event_operation_occ_invalid":
    case "event_mismatch":
    case "malformed_response":
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload("INTERNAL_SERVER_ERROR", "Internal server error"))
  }
}

export function validateOrganizationUpdate(body: unknown): E.Either<"invalid_organization", {displayName: string}> {
  if (typeof body !== "object" || body === null || !("displayName" in body) || typeof body.displayName !== "string")
    return E.left("invalid_organization")
  return E.right({displayName: body.displayName})
}

export function mapOrganizationToApiResponse(
  organization: OrganizationModel
): E.Either<"malformed_response", OrganizationSummary> {
  return pipe(
    validateOrganizationSummary({
      id: organization.id,
      slug: organization.slug,
      displayName: organization.displayName,
      status: organization.status
    }),
    E.mapLeft((): "malformed_response" => "malformed_response")
  )
}

export function generateErrorResponseForGetOrganization(
  error: OrganizationGetError | "malformed_response"
): HttpException {
  switch (error) {
    case "organization_not_found":
    case "resource_not_found":
      return new NotFoundException(generateErrorPayload("ORGANIZATION_NOT_FOUND", "Organization not found"))
    case "malformed_response":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Invalid organization response"))
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "invalid_credential":
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "permission_denied":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_already_exists":
    case "resource_in_use":
    case "concurrent_modification_error":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
    case "invitation_invalid":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "repository_dependency_error":
      return new ServiceUnavailableException(
        generateErrorPayload("STORAGE_UNAVAILABLE", "Organization lookup is unavailable")
      )
  }
}

export function generateErrorResponseForOrganizationMutation(
  error: OrganizationLifecycleError | OrganizationUpdateError | "invalid_etag" | "invalid_organization"
): HttpException {
  switch (error) {
    case "invalid_organization":
      return new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "displayName is required"))
    case "organization_summary_invalid_display_name":
      return new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization display name"))
    case "organization_malformed_object":
    case "organization_invalid_uuid":
    case "organization_id_mismatch":
    case "organization_slug_invalid":
    case "organization_display_name_empty":
    case "organization_display_name_too_long":
    case "organization_invalid_status":
    case "organization_status_reason_mismatch":
    case "organization_invalid_suspension_reason":
    case "organization_invalid_grace_until":
    case "organization_update_before_create":
    case "organization_summary_malformed_object":
    case "organization_summary_invalid_id":
    case "organization_summary_invalid_slug":
    case "organization_summary_invalid_status":
    case "organization_summary_invalid_occ":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Invalid organization metadata"))
    case "invalid_etag":
      return new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current organization tag")
      )
    case "permission_denied":
      return new ForbiddenException(generateErrorPayload("PERMISSION_DENIED", "Organization owner access is required"))
    case "organization_not_found":
      return new NotFoundException(generateErrorPayload("ORGANIZATION_NOT_FOUND", "Organization not found"))
    case "concurrent_modification_error":
      return new PreconditionFailedException(generateErrorPayload("STALE_ETAG", "Organization has changed"))
    case "organization_invalid_transition":
    case "organization_resume_not_permitted":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Organization lifecycle transition is invalid"),
        HttpStatus.CONFLICT
      )
    case "invalid_transition":
      return new HttpException(
        generateErrorPayload("INVALID_TRANSITION", "Organization lifecycle transition is invalid"),
        HttpStatus.CONFLICT
      )
    case "invalid_credential":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "step_up_context_missing":
    case "step_up_operation_mismatch":
    case "step_up_resource_mismatch":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Organization-bound step-up authentication is required"),
        HttpStatus.UNAUTHORIZED
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "invalid_reference":
    case "resource_not_found":
    case "resource_already_exists":
    case "resource_in_use":
    case "organization_owner_required":
    case "quota_exceeded":
    case "invitation_invalid":
    case "repository_dependency_error":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "agent_not_found":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_invalid_status":
    case "agent_update_before_create":
    case "role_invalid_uuid":
    case "role_name_empty":
    case "role_name_too_long":
    case "role_name_invalid_characters":
    case "role_permissions_empty":
    case "role_permission_invalid":
    case "role_invalid_scope":
    case "role_resource_id_invalid":
    case "role_resource_required_for_scope":
    case "role_resource_not_allowed_for_scope":
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "role_scope_incompatible_with_template":
    case "role_entity_type_role_restriction":
    case "role_invalid_structure":
    case "agent_role_invalid_uuid":
    case "agent_role_name_empty":
    case "agent_role_name_too_long":
    case "agent_role_name_invalid_characters":
    case "agent_role_permissions_empty":
    case "agent_role_permission_invalid":
    case "agent_role_invalid_scope":
    case "agent_role_resource_id_invalid":
    case "agent_role_resource_required_for_scope":
    case "agent_role_resource_not_allowed_for_scope":
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_total_roles_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "agent_role_scope_incompatible_with_template":
    case "agent_role_entity_type_role_restriction":
    case "agent_role_invalid_structure":
    case "unknown_error":
    case "account_not_found":
    case "audit_log_organization_mismatch":
    case "audit_log_malformed_object":
    case "audit_log_invalid_audit_type":
    case "audit_log_invalid_entity_type":
    case "audit_log_invalid_actor_type":
    case "audit_log_invalid_schema_version":
    case "audit_log_invalid_payload":
    case "audit_log_missing_required_fields":
    case "event_mismatch":
      return new ServiceUnavailableException(
        generateErrorPayload("STORAGE_UNAVAILABLE", "Organization lifecycle update is unavailable")
      )
  }
}
