import {OrganizationCreateResponse, OrganizationList, OrganizationModelValidationError} from "@approvio/api"
import {OrganizationSummary, User} from "@domain"
import {HttpException, HttpStatus, Logger} from "@nestjs/common"
import {OrganizationCreateError, OrganizationListError} from "@services"
import {generateErrorPayload} from "../error"

export type ListAccountOrganizationsError = OrganizationListError | "invalid_pagination"
export type CreateOrganizationError = OrganizationCreateError | OrganizationModelValidationError

export function mapOrganizationListToApiResponse(input: {
  readonly items: ReadonlyArray<OrganizationSummary>
  readonly total: number
  readonly page: number
  readonly limit: number
}): OrganizationList {
  return {
    items: input.items.map(({id, slug, displayName, status}) => ({id, slug, displayName, status})),
    total: input.total,
    page: input.page,
    limit: input.limit
  }
}

export function mapOrganizationCreationToApiResponse(input: {
  readonly organization: OrganizationSummary
  readonly owner: User
}): OrganizationCreateResponse {
  return {
    organization: {
      id: input.organization.id,
      slug: input.organization.slug,
      displayName: input.organization.displayName,
      status: input.organization.status
    },
    owner: {
      id: input.owner.id,
      organizationId: input.owner.organizationId,
      accountId: input.owner.accountId,
      displayName: input.owner.displayName,
      status: input.owner.status,
      orgRole: input.owner.orgRole
    }
  }
}

export function generateErrorResponseForListAccountOrganizations(error: ListAccountOrganizationsError): HttpException {
  switch (error) {
    case "invalid_pagination":
    case "invalid_page_number":
    case "invalid_limit_number":
      return new HttpException(
        generateErrorPayload("INVALID_PAGINATION", "Invalid page or limit"),
        HttpStatus.BAD_REQUEST
      )
    case "permission_denied":
      return new HttpException(
        generateErrorPayload("PERMISSION_DENIED", "An active account is required"),
        HttpStatus.FORBIDDEN
      )
    case "repository_dependency_error":
      Logger.error(`Organization discovery failed: ${error}`, "AccountOrganizationsController")
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Internal server error"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
  }
}

export function generateErrorResponseForCreateOrganization(error: CreateOrganizationError): HttpException {
  switch (error) {
    case "user_invalid_organization_id":
    case "user_invalid_uuid":
    case "user_invalid_account_id":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_org_role_invalid":
    case "user_status_invalid":
    case "user_update_before_create":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_role_organization_mismatch":
    case "user_membership_roles_invalid":
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
    case "audit_log_organization_mismatch":
    case "audit_log_malformed_object":
    case "audit_log_invalid_audit_type":
    case "audit_log_invalid_entity_type":
    case "audit_log_invalid_actor_type":
    case "audit_log_invalid_schema_version":
    case "audit_log_invalid_payload":
    case "audit_log_missing_required_fields":
    case "organization_summary_malformed_object":
    case "organization_summary_invalid_id":
    case "organization_summary_invalid_slug":
    case "organization_summary_invalid_display_name":
    case "organization_summary_invalid_status":
    case "organization_summary_invalid_occ":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
    case "concurrency_error":
    case "unknown_error":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Invalid domain state"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )

    case "malformed_object":
    case "missing_field":
    case "invalid_field":
    case "organization_slug_invalid":
    case "organization_display_name_empty":
    case "organization_display_name_too_long":
      return new HttpException(
        generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization details"),
        HttpStatus.BAD_REQUEST
      )
    case "resource_already_exists":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_ALREADY_EXISTS", "Organization slug is already in use"),
        HttpStatus.CONFLICT
      )
    case "permission_denied":
    case "organization_mismatch":
    case "organization_owner_required":
      return new HttpException(
        generateErrorPayload("PERMISSION_DENIED", "An active account is required"),
        HttpStatus.FORBIDDEN
      )
    case "quota_exceeded":
      return new HttpException(
        generateErrorPayload("QUOTA_EXCEEDED", "Organization creation quota exceeded"),
        HttpStatus.FORBIDDEN
      )
    case "invalid_credential":
      return new HttpException(
        generateErrorPayload("INVALID_SESSION", "Session is no longer active"),
        HttpStatus.UNAUTHORIZED
      )
    case "organization_context_changed":
    case "concurrent_modification_error":
    case "resource_in_use":
    case "invalid_transition":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Organization creation conflict"),
        HttpStatus.CONFLICT
      )
    case "organization_not_found":
    case "organization_deleting":
    case "resource_not_found":
      return new HttpException(
        generateErrorPayload("RESOURCE_NOT_FOUND", "Organization not found"),
        HttpStatus.NOT_FOUND
      )
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization is suspended"),
        HttpStatus.LOCKED
      )
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Additional authentication required"),
        HttpStatus.UNAUTHORIZED
      )
    case "invalid_reference":
    case "invitation_invalid":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Invalid organization creation request"),
        HttpStatus.BAD_REQUEST
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_malformed_object":
    case "organization_invalid_uuid":
    case "organization_id_mismatch":
    case "organization_invalid_status":
    case "organization_status_reason_mismatch":
    case "organization_invalid_suspension_reason":
    case "organization_invalid_grace_until":
    case "organization_update_before_create":
    case "repository_dependency_error":
      Logger.error(`Organization creation failed: ${error}`, "AccountOrganizationsController")
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Internal server error"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
  }
}
