// String() keeps this boundary defensive for errors originating in transport adapters.
import {
  AuthError,
  AuthService,
  RefreshTokenCreateError,
  RefreshTokenRefreshError,
  HighPrivilegeAuthError
} from "@services"
import {CliOrganizationSelectionValidationError} from "@approvio/api"
import {ExtractLeftFromMethod} from "@utils"
import {
  CliInitiateLoginRequestValidationError,
  CliGenerateTokenRequestValidationError,
  CliRefreshTokenRequestValidationError,
  CliPrivilegedTokenExchangeRequestValidationError
} from "./cli-auth.validators"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpStatus,
  NotFoundException,
  Logger
} from "@nestjs/common"
import {generateErrorPayload} from "@controllers/error"

export type CliAuthError =
  | AuthError
  | RefreshTokenCreateError
  | RefreshTokenRefreshError
  | HighPrivilegeAuthError
  | CliInitiateLoginRequestValidationError
  | CliGenerateTokenRequestValidationError
  | CliRefreshTokenRequestValidationError
  | CliPrivilegedTokenExchangeRequestValidationError

export type CliOrganizationSelectionError =
  ExtractLeftFromMethod<typeof AuthService, "selectCliOrganization"> | CliOrganizationSelectionValidationError

export function generateErrorResponseForCliOrganizationSelection(error: CliOrganizationSelectionError): HttpException {
  switch (error) {
    case "malformed_object":
    case "missing_organization_id":
    case "invalid_organization_id":
      return new BadRequestException(generateErrorPayload("INVALID_ORGANIZATION", "Invalid organization"))
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload("INVALID_SESSION", "Session is no longer active"))
    case "account_not_found":
      return new UnauthorizedException(generateErrorPayload("ACCOUNT_NOT_FOUND", "Account not found"))
    case "permission_denied":
    case "organization_mismatch":
    case "resource_not_found":
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
    case "organization_owner_required":
    case "quota_exceeded":
      return new ForbiddenException(generateErrorPayload(error.toUpperCase(), "Organization selection not authorized"))
    case "invalid_reference":
    case "invitation_invalid":
      return new BadRequestException(
        generateErrorPayload(error.toUpperCase(), "Invalid organization selection request")
      )
    case "organization_context_changed":
    case "concurrent_modification_error":
    case "resource_already_exists":
    case "resource_in_use":
    case "invalid_transition":
    case "concurrency_error":
      return new ConflictException(generateErrorPayload(error.toUpperCase(), "Organization selection conflict"))
    case "tenant_context_required":
    case "repository_dependency_error":
    case "auth_token_generation_failed":
    case "refresh_token_invalid_organization_id":
    case "refresh_token_invalid_structure":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_account_id":
    case "refresh_token_invalid_session_id":
    case "refresh_token_invalid_provider_id":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_used_at":
    case "refresh_token_used_before_create":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_missing_occ":
    case "unknown_error":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "commit_outcome_unknown":
    case "storage_unavailable":
      Logger.error(`CLI organization selection failed: ${error}`, "CliAuthController")
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", "Organization selection failed"))
  }
}

export function generateErrorResponseForCliInitiate(error: CliAuthError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (String(error)) {
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: invalid session`))
    case "account_display_name_empty":
    case "account_display_name_too_long":
    case "account_invalid_profile_email":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid account profile`))
    case "session_invalid_id":
    case "session_invalid_account_id":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid session data`))
    case "account_malformed_object":
    case "account_invalid_uuid":
    case "account_invalid_status":
    case "account_update_before_create":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid account data`))
    case "request_empty_body":
    case "request_missing_refresh_token":
    case "request_invalid_refresh_token":
    case "refresh_token_not_found":
    case "refresh_token_entity_mismatch":
    case "dpop_expected_url_parsing_failed":
    case "dpop_htu_url_parsing_failed":
    case "dpop_import_key_failed":
    case "dpop_invalid_htm_claim":
    case "dpop_invalid_htu_claim":
    case "dpop_invalid_signature":
    case "dpop_jwt_expired":
    case "dpop_jwt_invalid":
    case "dpop_jwt_verify_failed":
    case "dpop_missing_htm_claim":
    case "dpop_missing_htu_claim":
    case "dpop_missing_iat_claim":
    case "dpop_missing_jti_claim":
    case "agent_not_found":
    case "refresh_token_expired":
    case "refresh_token_revoked":
    case "auth_token_generation_failed":
    case "auth_authorization_url_generation_failed":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_exists":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "user_identity_already_exists":
    case "user_not_found":
    case "request_invalid_user_identifier":
    case "auth_invalid_redirect_uri":
    case "request_missing_redirect_uri":
    case "request_invalid_redirect_uri":
    case "request_invalid_provider":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "request_invalid_resource_id":
    case "request_missing_operation":
    case "request_invalid_operation":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_reuse_detected":
    case "refresh_token_concurrent_update":
    case "pkce_code_concurrency_conflict":
    case "agent_challenge_concurrent_update":
    case "organization_admin_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: insufficient permissions`))
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "auth_invalid_entity":
    case "organization_not_found":
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
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
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_already_exists":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "auth_high_privilege_flow_disabled":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, `${context}: functionality is not enabled`)
      )
    case "unknown_error":
    case "quota_check_error":
    case "agent_token_generation_failed":
    case "oidc_unknown_error":
    case "oidc_provider_not_found":
    case "oidc_network_error":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_dpop_jkt":
    case "refresh_token_invalid_entity_type":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_invalid_user_id":
    case "refresh_token_missing_entity_id":
    case "refresh_token_missing_entity_type":
    case "refresh_token_missing_provider_id":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_jwt_expired":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_not_yet_valid":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_invalid_claim_value":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_invalid_challenge_format":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_update_failed":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }

  // The fallback protects the HTTP boundary if a new service error is added without a mapping.
  return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
}

export function generateErrorResponseForCliGenerateToken(error: CliAuthError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (String(error)) {
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: invalid session`))
    case "account_display_name_empty":
    case "account_display_name_too_long":
    case "account_invalid_profile_email":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid account profile`))
    case "session_invalid_id":
    case "session_invalid_account_id":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid session data`))
    case "account_malformed_object":
    case "account_invalid_uuid":
    case "account_invalid_status":
    case "account_update_before_create":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid account data`))
    case "request_empty_body":
    case "request_missing_refresh_token":
    case "request_invalid_refresh_token":
    case "refresh_token_not_found":
    case "refresh_token_entity_mismatch":
    case "dpop_expected_url_parsing_failed":
    case "dpop_htu_url_parsing_failed":
    case "dpop_import_key_failed":
    case "dpop_invalid_htm_claim":
    case "dpop_invalid_htu_claim":
    case "dpop_invalid_signature":
    case "dpop_jwt_expired":
    case "dpop_jwt_invalid":
    case "dpop_jwt_verify_failed":
    case "dpop_missing_htm_claim":
    case "dpop_missing_htu_claim":
    case "dpop_missing_iat_claim":
    case "dpop_missing_jti_claim":
    case "agent_not_found":
    case "refresh_token_expired":
    case "refresh_token_revoked":
    case "auth_token_generation_failed":
    case "auth_authorization_url_generation_failed":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_exists":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "user_identity_already_exists":
    case "user_not_found":
    case "request_invalid_user_identifier":
    case "auth_invalid_redirect_uri":
    case "request_missing_redirect_uri":
    case "request_invalid_redirect_uri":
    case "request_invalid_provider":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "request_invalid_resource_id":
    case "request_missing_operation":
    case "request_invalid_operation":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_reuse_detected":
    case "refresh_token_concurrent_update":
    case "pkce_code_concurrency_conflict":
    case "agent_challenge_concurrent_update":
    case "organization_admin_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: insufficient permissions`))
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "auth_invalid_entity":
    case "organization_not_found":
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
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
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_already_exists":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "auth_high_privilege_flow_disabled":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, `${context}: functionality is not enabled`)
      )
    case "unknown_error":
    case "quota_check_error":
    case "agent_token_generation_failed":
    case "oidc_unknown_error":
    case "oidc_provider_not_found":
    case "oidc_network_error":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_dpop_jkt":
    case "refresh_token_invalid_entity_type":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_invalid_user_id":
    case "refresh_token_missing_entity_id":
    case "refresh_token_missing_entity_type":
    case "refresh_token_missing_provider_id":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_jwt_expired":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_not_yet_valid":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_invalid_claim_value":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_invalid_challenge_format":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_update_failed":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
  // Keep an internal-error fallback for newly added service errors.
  return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
}

export function generateErrorResponseForCliRefreshUserToken(error: CliAuthError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (String(error)) {
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: invalid session`))
    case "account_display_name_empty":
    case "account_display_name_too_long":
    case "account_invalid_profile_email":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid account profile`))
    case "session_invalid_id":
    case "session_invalid_account_id":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid session data`))
    case "account_malformed_object":
    case "account_invalid_uuid":
    case "account_invalid_status":
    case "account_update_before_create":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid account data`))
    case "request_empty_body":
    case "request_missing_refresh_token":
    case "request_invalid_refresh_token":
    case "refresh_token_not_found":
    case "refresh_token_entity_mismatch":
    case "dpop_expected_url_parsing_failed":
    case "dpop_htu_url_parsing_failed":
    case "dpop_import_key_failed":
    case "dpop_invalid_htm_claim":
    case "dpop_invalid_htu_claim":
    case "dpop_invalid_signature":
    case "dpop_jwt_expired":
    case "dpop_jwt_invalid":
    case "dpop_jwt_verify_failed":
    case "dpop_missing_htm_claim":
    case "dpop_missing_htu_claim":
    case "dpop_missing_iat_claim":
    case "dpop_missing_jti_claim":
    case "agent_not_found":
    case "refresh_token_expired":
    case "refresh_token_revoked":
    case "auth_token_generation_failed":
    case "auth_authorization_url_generation_failed":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_exists":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "user_identity_already_exists":
    case "user_not_found":
    case "request_invalid_user_identifier":
    case "auth_invalid_redirect_uri":
    case "request_missing_redirect_uri":
    case "request_invalid_redirect_uri":
    case "request_invalid_provider":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "request_invalid_resource_id":
    case "request_missing_operation":
    case "request_invalid_operation":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_reuse_detected":
    case "refresh_token_concurrent_update":
    case "pkce_code_concurrency_conflict":
    case "agent_challenge_concurrent_update":
    case "organization_admin_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: insufficient permissions`))
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "auth_invalid_entity":
    case "organization_not_found":
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
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
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_already_exists":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "auth_high_privilege_flow_disabled":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, `${context}: functionality is not enabled`)
      )
    case "unknown_error":
    case "quota_check_error":
    case "agent_token_generation_failed":
    case "oidc_unknown_error":
    case "oidc_provider_not_found":
    case "oidc_network_error":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_dpop_jkt":
    case "refresh_token_invalid_entity_type":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_invalid_user_id":
    case "refresh_token_missing_entity_id":
    case "refresh_token_missing_entity_type":
    case "refresh_token_missing_provider_id":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_jwt_expired":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_not_yet_valid":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_invalid_claim_value":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_invalid_challenge_format":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_update_failed":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
  // Keep an internal-error fallback for newly added service errors.
  return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
}

export function generateErrorResponseForCliExchangePrivilegeToken(error: CliAuthError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (String(error)) {
    case "invalid_credential":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: invalid session`))
    case "account_display_name_empty":
    case "account_display_name_too_long":
    case "account_invalid_profile_email":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid account profile`))
    case "session_invalid_id":
    case "session_invalid_account_id":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid session data`))
    case "account_malformed_object":
    case "account_invalid_uuid":
    case "account_invalid_status":
    case "account_update_before_create":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: invalid account data`))
    case "request_empty_body":
    case "request_missing_refresh_token":
    case "request_invalid_refresh_token":
    case "refresh_token_not_found":
    case "refresh_token_entity_mismatch":
    case "dpop_expected_url_parsing_failed":
    case "dpop_htu_url_parsing_failed":
    case "dpop_import_key_failed":
    case "dpop_invalid_htm_claim":
    case "dpop_invalid_htu_claim":
    case "dpop_invalid_signature":
    case "dpop_jwt_expired":
    case "dpop_jwt_invalid":
    case "dpop_jwt_verify_failed":
    case "dpop_missing_htm_claim":
    case "dpop_missing_htu_claim":
    case "dpop_missing_iat_claim":
    case "dpop_missing_jti_claim":
    case "agent_not_found":
    case "refresh_token_expired":
    case "refresh_token_revoked":
    case "auth_token_generation_failed":
    case "auth_authorization_url_generation_failed":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_exists":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "user_identity_already_exists":
    case "user_not_found":
    case "request_invalid_user_identifier":
    case "auth_invalid_redirect_uri":
    case "request_missing_redirect_uri":
    case "request_invalid_redirect_uri":
    case "request_invalid_provider":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "request_invalid_resource_id":
    case "request_missing_resource_id":
    case "request_missing_operation":
    case "request_invalid_operation":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_reuse_detected":
    case "refresh_token_concurrent_update":
    case "pkce_code_concurrency_conflict":
    case "agent_challenge_concurrent_update":
    case "organization_admin_already_exists":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "requestor_not_authorized":
      return new ForbiddenException(generateErrorPayload(errorCode, `${context}: insufficient permissions`))
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "auth_invalid_entity":
    case "organization_not_found":
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
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
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "user_already_exists":
      return new InternalServerErrorException(
        generateErrorPayload(errorCode, `${context}: OIDC step-up token verification failed`)
      )
    case "auth_high_privilege_flow_disabled":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, `${context}: functionality is not enabled`)
      )
    case "unknown_error":
    case "quota_check_error":
    case "agent_token_generation_failed":
    case "oidc_unknown_error":
    case "oidc_provider_not_found":
    case "oidc_network_error":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_dpop_jkt":
    case "refresh_token_invalid_entity_type":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_invalid_user_id":
    case "refresh_token_missing_entity_id":
    case "refresh_token_missing_entity_type":
    case "refresh_token_missing_provider_id":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_jwt_expired":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_not_yet_valid":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_invalid_claim_value":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_invalid_challenge_format":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_update_failed":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
  }
  // Keep an internal-error fallback for newly added service errors.
  return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
}
