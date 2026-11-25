import {AuthError, AuthService, RefreshTokenCreateError} from "@services"
import {ExtractLeftFromMethod} from "@utils"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PreconditionFailedException,
  UnauthorizedException
} from "@nestjs/common"
import {generateErrorPayload} from "../error"
import {WebCallbackRequestValidationError} from "./web-auth.validators"
import {WebOrganizationSwitchValidationError} from "@approvio/api"

export type WebCallbackError = AuthError | RefreshTokenCreateError | WebCallbackRequestValidationError

export type WebSessionContextError = ExtractLeftFromMethod<typeof AuthService, "getWebSessionContext">
export type WebOrganizationSwitchError =
  | ExtractLeftFromMethod<typeof AuthService, "switchWebOrganization">
  | WebOrganizationSwitchValidationError
  | "invalid_etag"

export function generateErrorResponseForWebSessionContext(error: WebSessionContextError): HttpException {
  switch (error) {
    case "session_not_found":
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "Session is no longer active"))
    case "organization_context_changed":
      return new ConflictException(generateErrorPayload("ORGANIZATION_CONTEXT_CHANGED", "Organization context changed"))
    case "invalid_organization_id":
      return new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization"))
    case "organization_mismatch":
    case "permission_denied":
      return new ForbiddenException(generateErrorPayload("PERMISSION_DENIED", "Organization access denied"))
    case "organization_not_found":
    case "organization_deleting":
      return new NotFoundException(generateErrorPayload("RESOURCE_NOT_FOUND", "Organization not found"))
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization is suspended"),
        HttpStatus.LOCKED
      )
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
      return new UnauthorizedException(generateErrorPayload(error.toUpperCase(), "Additional authentication required"))
    case "tenant_context_required":
    case "session_invalid_id":
    case "session_invalid_account_id":
    case "repository_dependency_error":
      Logger.error(`Web session context failed: ${error}`, "WebAuthController")
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Failed to read session"))
  }
}

export function generateErrorResponseForWebOrganizationSwitch(error: WebOrganizationSwitchError): HttpException {
  switch (error) {
    case "malformed_object":
    case "missing_organization_id":
    case "missing_expected_context_version":
    case "invalid_expected_context_version":
    case "invalid_organization_id":
      return new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization"))
    case "invalid_etag":
    case "organization_context_changed":
    case "concurrent_modification_error":
      return new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current session tag")
      )
    case "permission_denied":
    case "organization_mismatch":
    case "resource_not_found":
      return new ForbiddenException(generateErrorPayload("PERMISSION_DENIED", "Organization access denied"))
    case "session_not_found":
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "Session is no longer active"))
    case "account_not_found":
      return new UnauthorizedException(generateErrorPayload("ACCOUNT_NOT_FOUND", "Account not found"))
    case "organization_not_found":
    case "organization_deleting":
      return new NotFoundException(generateErrorPayload("RESOURCE_NOT_FOUND", "Organization not found"))
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization is suspended"),
        HttpStatus.LOCKED
      )
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "organization_owner_required":
    case "quota_exceeded":
      return new ForbiddenException(generateErrorPayload(error.toUpperCase(), "Organization switch not authorized"))
    case "invalid_reference":
    case "invitation_invalid":
      return new BadRequestException(generateErrorPayload(error.toUpperCase(), "Invalid organization switch request"))
    case "resource_already_exists":
    case "resource_in_use":
    case "invalid_transition":
    case "concurrency_error":
      return new ConflictException(generateErrorPayload(error.toUpperCase(), "Organization switch conflict"))
    case "tenant_context_required":
    case "session_invalid_id":
    case "session_invalid_account_id":
    case "user_invalid_uuid":
    case "user_invalid_organization_id":
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
    case "account_malformed_object":
    case "account_invalid_uuid":
    case "account_display_name_empty":
    case "account_display_name_too_long":
    case "account_invalid_profile_email":
    case "account_invalid_status":
    case "account_update_before_create":
    case "repository_dependency_error":
    case "auth_token_generation_failed":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "storage_unavailable":
      Logger.error(`Web organization switch failed: ${error}`, "WebAuthController")
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Organization switch failed"))
  }
}

export function mapWebCallbackErrorToCode(error: WebCallbackError): string {
  if (error === "repository_dependency_error") return "auth_failed"
  return error.toLowerCase()
}
