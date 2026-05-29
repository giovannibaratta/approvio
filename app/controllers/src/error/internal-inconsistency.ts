import { InternalServerErrorException, Logger } from "@nestjs/common"
import { generateErrorPayload } from "@controllers/error"

export function handleInternalInconsistency(errorCode: string, context: string): InternalServerErrorException {
  Logger.error(`Internal data inconsistency: ${errorCode}`)
  return new InternalServerErrorException(
    generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
  )
}

export function isInternalInconsistencyError(error: string): boolean {
  switch (error) {
    case "agent_challenge_agent_name_empty":
    case "agent_challenge_agent_name_invalid":
    case "agent_challenge_challenge_already_used":
    case "agent_challenge_challenge_expired":
    case "agent_challenge_concurrent_update":
    case "agent_challenge_decryption_failed":
    case "agent_challenge_expire_before_creation":
    case "agent_challenge_invalid_agent_ownership":
    case "agent_challenge_invalid_audience":
    case "agent_challenge_invalid_challenge_format":
    case "agent_challenge_invalid_claim_value":
    case "agent_challenge_invalid_issuer":
    case "agent_challenge_invalid_jwt_format":
    case "agent_challenge_invalid_jwt_signature":
    case "agent_challenge_invalid_occ":
    case "agent_challenge_invalid_uuid":
    case "agent_challenge_jwt_expired":
    case "agent_challenge_jwt_not_yet_valid":
    case "agent_challenge_missing_required_claim":
    case "agent_challenge_nonce_empty":
    case "agent_challenge_nonce_invalid_length":
    case "agent_challenge_nonce_mismatch":
    case "agent_challenge_not_found":
    case "agent_challenge_update_failed":
    case "agent_challenge_used_at_before_creation":
    case "agent_invalid_occ":
    case "agent_invalid_uuid":
    case "agent_key_decode_error":
    case "agent_name_cannot_be_uuid":
    case "agent_name_empty":
    case "agent_name_too_long":
    case "agent_role_assignments_empty":
    case "agent_role_assignments_exceed_maximum":
    case "agent_role_entity_type_role_restriction":
    case "agent_role_invalid_scope":
    case "agent_role_invalid_structure":
    case "agent_role_invalid_uuid":
    case "agent_role_name_empty":
    case "agent_role_name_invalid_characters":
    case "agent_role_name_too_long":
    case "agent_role_permission_invalid":
    case "agent_role_permissions_empty":
    case "agent_role_resource_id_invalid":
    case "agent_role_resource_not_allowed_for_scope":
    case "agent_role_resource_required_for_scope":
    case "agent_role_scope_incompatible_with_template":
    case "agent_role_total_roles_exceed_maximum":
    case "agent_role_unknown_role_name":
    case "auth_invalid_entity":
    case "oidc_invalid_provider_response":
    case "oidc_invalid_token_response":
    case "oidc_invalid_userinfo_response":
    case "oidc_network_error":
    case "oidc_token_exchange_failed":
    case "oidc_unknown_error":
    case "oidc_userinfo_fetch_failed":
    case "organization_admin_already_exists":
    case "organization_admin_email_empty":
    case "organization_admin_email_invalid":
    case "organization_admin_email_too_long":
    case "organization_admin_invalid_uuid":
    case "organization_not_found":
    case "pkce_code_already_used":
    case "pkce_code_concurrency_conflict":
    case "pkce_code_expired":
    case "pkce_code_generation_failed":
    case "pkce_code_not_found":
    case "pkce_code_storage_failed":
    case "pkce_code_verification_failed":
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
    case "refresh_token_invalid_structure":
    case "refresh_token_invalid_token_hash":
    case "refresh_token_invalid_used_at":
    case "refresh_token_invalid_user_id":
    case "refresh_token_missing_entity_id":
    case "refresh_token_missing_entity_type":
    case "refresh_token_missing_occ":
    case "refresh_token_used_before_create":
    case "request_invalid_user_identifier":
    case "requestor_not_authorized":
    case "role_assignments_empty":
    case "role_assignments_exceed_maximum":
    case "role_entity_type_role_restriction":
    case "role_invalid_scope":
    case "role_invalid_structure":
    case "role_invalid_uuid":
    case "role_name_empty":
    case "role_name_invalid_characters":
    case "role_name_too_long":
    case "role_permission_invalid":
    case "role_permissions_empty":
    case "role_resource_id_invalid":
    case "role_resource_not_allowed_for_scope":
    case "role_resource_required_for_scope":
    case "role_scope_incompatible_with_template":
    case "role_total_roles_exceed_maximum":
    case "role_unknown_role_name":
    case "user_already_exists":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_duplicate_roles":
    case "user_email_empty":
    case "user_email_invalid":
    case "user_email_too_long":
    case "user_invalid_uuid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
      return true
    default:
      return false
  }
}
