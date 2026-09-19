import {
  AuthError,
  GetGroupRepoError,
  RefreshTokenCreateError,
  RefreshTokenRefreshError,
  TokenPair,
  PrivilegeTokenExchange,
  HighPrivilegeAuthError
} from "@services"
import {
  GenerateTokenRequestValidationError,
  RefreshAgentTokenRequestValidationError,
  RefreshTokenRequestValidationError,
  PrivilegedTokenExchangeRequestValidationError
} from "./auth.validators"
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common"
import {GetEntityInfo200Response, TokenResponse, PrivilegedTokenExchangeRequest} from "@approvio/api"
import {generateErrorPayload} from "@controllers/error"
import {Either, left, right} from "fp-ts/Either"
import {AuthenticatedEntity, Group, isStepUpOperation} from "@domain"

type RefreshUserTokenError = RefreshTokenRequestValidationError | RefreshTokenRefreshError
type RefreshAgentTokenError = RefreshAgentTokenRequestValidationError | RefreshTokenRefreshError
type GenerateTokenError = RefreshTokenCreateError | GenerateTokenRequestValidationError | AuthError
type ExchangePrivilegeTokenError = PrivilegedTokenExchangeRequestValidationError | HighPrivilegeAuthError

export function generateErrorResponseForRefreshUserToken(error: RefreshUserTokenError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "session_not_found":
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
    case "identity_already_linked":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "auth_invalid_redirect_uri":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_reuse_detected":
    case "refresh_token_concurrent_update":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "unknown_error":
    case "agent_token_generation_failed":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_expired":
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
    case "agent_challenge_concurrent_update":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "organization_not_found":
    case "oidc_unknown_error":
    case "oidc_provider_not_found":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "oidc_invalid_provider_response":
    case "oidc_network_error":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
    case "pkce_code_concurrency_conflict":
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_name_cannot_be_uuid":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "invalid_organization_id":
    case "user_invalid_organization_id":
    case "user_invalid_account_id":
    case "user_status_invalid":
    case "user_update_before_create":
    case "user_role_organization_mismatch":
    case "user_membership_roles_invalid":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "storage_unavailable":
    case "concurrency_error":
    case "repository_dependency_error":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_update_before_create":
    case "agent_invalid_status":
    case "agent_challenge_agent_id_invalid":
    case "agent_challenge_organization_id_invalid":
    case "account_not_found":
    case "ciphertext_context_mismatch":
    case "invalid_encryption_context":
    case "cross_organization_reencryption_forbidden":
    case "incompatible_reencryption_context":
    case "unsupported_format":
    case "pkce_session_malformed_object":
    case "pkce_session_invalid_state":
    case "pkce_session_invalid_code_verifier":
    case "pkce_session_invalid_redirect_uri":
    case "pkce_session_invalid_oidc_state":
    case "pkce_session_invalid_provider_id":
    case "pkce_session_invalid_created_at":
    case "pkce_session_invalid_expires_at":
    case "pkce_session_invalid_occ":
    case "pkce_session_invalid_used_at":
    case "pkce_session_invalid_flow":
    case "pkce_session_unexpected_step_up_context":
    case "pkce_session_invalid_session_id":
    case "pkce_session_invalid_step_up_target":
    case "pkce_session_invalid_organization_id":
    case "pkce_session_invalid_operation":
    case "pkce_session_invalid_resource_id":
    case "pkce_session_invalid_context_version":
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "permission_denied":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_not_found":
    case "resource_already_exists":
    case "resource_in_use":
    case "concurrent_modification_error":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
    case "invitation_invalid":
    case "refresh_token_invalid_organization_id":
    case "refresh_token_invalid_account_id":
    case "refresh_token_invalid_session_id":
    case "refresh_token_invalid_provider_id":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
  }
}

export function generateErrorResponseForExchangePrivilegeToken(
  error: ExchangePrivilegeTokenError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()
  switch (error) {
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
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "request_invalid_resource_id":
    case "request_missing_resource_id":
    case "request_missing_operation":
    case "request_invalid_operation":
    case "auth_invalid_redirect_uri":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "auth_token_generation_failed":
    case "step_up_receipt_malformed_object":
    case "step_up_receipt_invalid_id":
    case "step_up_receipt_invalid_organization_id":
    case "step_up_receipt_invalid_jti":
    case "step_up_receipt_invalid_user_id":
    case "step_up_receipt_invalid_session_id":
    case "step_up_receipt_invalid_provider_id":
    case "step_up_receipt_invalid_context_version":
    case "step_up_receipt_invalid_operation":
    case "step_up_receipt_invalid_resource_id":
    case "step_up_receipt_invalid_expires_at":
    case "step_up_receipt_invalid_created_at":
    case "step_up_receipt_invalid_consumed_at":
    case "unknown_error":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_already_linked":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "auth_authorization_url_generation_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
    case "oidc_provider_not_found":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "organization_not_found":
    case "auth_invalid_entity":
    case "encryption_failed":
    case "decryption_failed":
      Logger.error(`Error in OIDC step-up token verification: ${context}`, error)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: OIDC step-up token verification failed`)
      )
    case "oidc_network_error":
    case "oidc_invalid_userinfo_response":
    case "oidc_unknown_error":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "pkce_code_concurrency_conflict":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "auth_high_privilege_flow_disabled":
      return new ServiceUnavailableException(
        generateErrorPayload(errorCode, `${context}: functionality is not enabled`)
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "storage_unavailable":
    case "concurrency_error":
    case "repository_dependency_error":
    case "agent_not_found":
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_name_cannot_be_uuid":
    case "agent_invalid_occ":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_update_before_create":
    case "agent_invalid_status":
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
    case "account_not_found":
    case "ciphertext_context_mismatch":
    case "invalid_encryption_context":
    case "cross_organization_reencryption_forbidden":
    case "incompatible_reencryption_context":
    case "unsupported_format":
    case "pkce_session_malformed_object":
    case "pkce_session_invalid_state":
    case "pkce_session_invalid_code_verifier":
    case "pkce_session_invalid_redirect_uri":
    case "pkce_session_invalid_oidc_state":
    case "pkce_session_invalid_provider_id":
    case "pkce_session_invalid_created_at":
    case "pkce_session_invalid_expires_at":
    case "pkce_session_invalid_occ":
    case "pkce_session_invalid_used_at":
    case "pkce_session_invalid_flow":
    case "pkce_session_unexpected_step_up_context":
    case "pkce_session_invalid_session_id":
    case "pkce_session_invalid_step_up_target":
    case "pkce_session_invalid_organization_id":
    case "pkce_session_invalid_operation":
    case "pkce_session_invalid_resource_id":
    case "pkce_session_invalid_context_version":
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "permission_denied":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_not_found":
    case "resource_already_exists":
    case "resource_in_use":
    case "concurrent_modification_error":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
    case "invitation_invalid":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
  }
}

export function mapToTokenResponse(data: TokenPair): TokenResponse {
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken
  }
}

export function generateErrorResponseForRefreshAgentToken(
  error: RefreshAgentTokenError,
  context: string
): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "session_not_found":
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
    case "identity_already_linked":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "request_invalid_dpop_jkt":
    case "auth_invalid_redirect_uri":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: invalid request`))
    case "refresh_token_concurrent_update":
    case "refresh_token_reuse_detected":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: concurrent update. Try again`))
    case "unknown_error":
    case "agent_token_generation_failed":
    case "oidc_unknown_error":
    case "encryption_failed":
    case "decryption_failed":
      Logger.error(`Unknown error: ${errorCode}`)
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "agent_key_decode_error":
    case "agent_invalid_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_invalid_occ":
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
    case "agent_challenge_not_found":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_jwt_expired":
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
    case "agent_challenge_concurrent_update":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_used_at_before_creation":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "organization_not_found":
    case "oidc_provider_not_found":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "oidc_invalid_provider_response":
    case "oidc_network_error":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
    case "pkce_code_concurrency_conflict":
    case "refresh_token_invalid_structure":
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
    case "agent_name_cannot_be_uuid":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "dpop_jti_reused":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: unauthorized request`))
    case "invalid_organization_id":
    case "user_invalid_organization_id":
    case "user_invalid_account_id":
    case "user_status_invalid":
    case "user_update_before_create":
    case "user_role_organization_mismatch":
    case "user_membership_roles_invalid":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "storage_unavailable":
    case "concurrency_error":
    case "repository_dependency_error":
    case "agent_invalid_organization_id":
    case "agent_role_organization_mismatch":
    case "agent_update_before_create":
    case "agent_invalid_status":
    case "agent_challenge_agent_id_invalid":
    case "agent_challenge_organization_id_invalid":
    case "account_not_found":
    case "ciphertext_context_mismatch":
    case "invalid_encryption_context":
    case "cross_organization_reencryption_forbidden":
    case "incompatible_reencryption_context":
    case "unsupported_format":
    case "pkce_session_malformed_object":
    case "pkce_session_invalid_state":
    case "pkce_session_invalid_code_verifier":
    case "pkce_session_invalid_redirect_uri":
    case "pkce_session_invalid_oidc_state":
    case "pkce_session_invalid_provider_id":
    case "pkce_session_invalid_created_at":
    case "pkce_session_invalid_expires_at":
    case "pkce_session_invalid_occ":
    case "pkce_session_invalid_used_at":
    case "pkce_session_invalid_flow":
    case "pkce_session_unexpected_step_up_context":
    case "pkce_session_invalid_session_id":
    case "pkce_session_invalid_step_up_target":
    case "pkce_session_invalid_organization_id":
    case "pkce_session_invalid_operation":
    case "pkce_session_invalid_resource_id":
    case "pkce_session_invalid_context_version":
    case "organization_context_changed":
    case "organization_suspended":
    case "organization_deleting":
    case "permission_denied":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "invalid_reference":
    case "resource_not_found":
    case "resource_already_exists":
    case "resource_in_use":
    case "concurrent_modification_error":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
    case "invitation_invalid":
    case "refresh_token_invalid_organization_id":
    case "refresh_token_invalid_account_id":
    case "refresh_token_invalid_session_id":
    case "refresh_token_invalid_provider_id":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
  }
}

export function generateErrorResponseForGenerateToken(error: GenerateTokenError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
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
    case "refresh_token_expire_before_create":
    case "refresh_token_invalid_agent_id":
    case "refresh_token_invalid_created_at":
    case "refresh_token_invalid_expires_at":
    case "refresh_token_invalid_family_id":
    case "refresh_token_invalid_id":
    case "refresh_token_invalid_next_token_id":
    case "refresh_token_invalid_status":
    case "refresh_token_invalid_structure":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_used_before_create":
    case "refresh_token_missing_occ":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "oidc_network_error":
    case "oidc_provider_not_found":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_token_exchange_failed":
    case "oidc_userinfo_fetch_failed":
    case "pkce_code_generation_failed":
    case "pkce_code_storage_failed":
    case "auth_token_generation_failed":
    case "auth_authorization_url_generation_failed":
    case "auth_missing_email_from_oidc_provider":
    case "auth_identity_conflict":
    case "identity_already_linked":
    case "auth_invalid_oidc_provider":
    case "auth_missing_oidc_provider":
    case "oidc_unknown_error":
    case "unknown_error":
    case "auth_invalid_redirect_uri":
    case "encryption_failed":
    case "decryption_failed":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unknown error`))
    case "request_empty_body":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: ${errorCode}`))
    case "pkce_code_concurrency_conflict":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: ${errorCode}`))
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "repository_dependency_error":
    case "account_not_found":
    case "ciphertext_context_mismatch":
    case "invalid_encryption_context":
    case "cross_organization_reencryption_forbidden":
    case "incompatible_reencryption_context":
    case "unsupported_format":
    case "pkce_session_malformed_object":
    case "pkce_session_invalid_state":
    case "pkce_session_invalid_code_verifier":
    case "pkce_session_invalid_redirect_uri":
    case "pkce_session_invalid_oidc_state":
    case "pkce_session_invalid_provider_id":
    case "pkce_session_invalid_created_at":
    case "pkce_session_invalid_expires_at":
    case "pkce_session_invalid_occ":
    case "pkce_session_invalid_used_at":
    case "pkce_session_invalid_flow":
    case "pkce_session_unexpected_step_up_context":
    case "pkce_session_invalid_session_id":
    case "pkce_session_invalid_step_up_target":
    case "pkce_session_invalid_organization_id":
    case "pkce_session_invalid_operation":
    case "pkce_session_invalid_resource_id":
    case "pkce_session_invalid_context_version":
    case "refresh_token_invalid_organization_id":
    case "refresh_token_invalid_account_id":
    case "refresh_token_invalid_session_id":
    case "refresh_token_invalid_provider_id":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
  }
}

export function mapToEntityInfoResponse(entity: AuthenticatedEntity, groups: Group[]): GetEntityInfo200Response {
  const baseInfo = {
    groups: groups.map(g => ({
      groupId: g.id,
      groupName: g.name
    }))
  }

  if (entity.entityType === "user")
    return {
      ...baseInfo,
      entityType: "user",
      id: entity.user.id,
      organizationId: entity.user.organizationId,
      roles: entity.user.roles.map(r => ({
        roleName: r.name,
        scope: r.scope
      })),
      orgRole: entity.user.orgRole
    }

  return {
    ...baseInfo,
    entityType: "agent",
    id: entity.agent.id,
    organizationId: entity.agent.organizationId,
    roles: entity.agent.roles.map(r => ({
      roleName: r.name,
      scope: r.scope
    }))
  }
}

export function generateErrorResponseForEntityInfo(error: GetGroupRepoError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: unknown error`))
    case "group_not_found":
    case "group_name_empty":
    case "group_name_too_long":
    case "group_name_invalid_characters":
    case "group_update_before_create":
    case "group_description_too_long":
    case "group_entities_count_invalid":
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "conflicting_isolation_level":
    case "retry_exhausted":
    case "storage_unavailable":
    case "concurrency_error":
    case "group_invalid_organization_id":
      return new InternalServerErrorException(generateErrorPayload("UNKNOWN_ERROR", `${context}: unexpected error`))
  }
}

export function mapToPrivilegeTokenExchange(
  request: PrivilegedTokenExchangeRequest
): Either<PrivilegedTokenExchangeRequestValidationError, PrivilegeTokenExchange> {
  if (!isStepUpOperation(request.operation)) return left("request_invalid_operation")
  if (typeof request.resourceId !== "string" || !request.resourceId) return left("request_invalid_resource_id")

  return right({
    code: request.code,
    state: request.state,
    operation: request.operation,
    resourceId: request.resourceId
  })
}
