import {TokenResponse} from "@approvio/api"
import {generateErrorPayload} from "@controllers/error"
import {
  HttpException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  ConflictException,
  UnauthorizedException
} from "@nestjs/common"
import {GenerateTokenRequestValidationError} from "./auth.validators"
import {AuthError} from "@services"

type GenerateTokenError = GenerateTokenRequestValidationError | AuthError

export function mapToTokenResponse(data: string): TokenResponse {
  return {
    token: data
  }
}

export function generateErrorResponseForGenerateToken(error: GenerateTokenError, context: string): HttpException {
  const errorCode = error.toUpperCase()

  switch (error) {
    case "request_invalid_user_identifier":
    case "user_invalid_uuid":
    case "user_display_name_empty":
    case "user_display_name_too_long":
    case "user_email_empty":
    case "user_email_too_long":
    case "user_email_invalid":
    case "user_org_role_invalid":
    case "user_role_assignments_invalid_format":
    case "user_duplicate_roles":
    case "role_invalid_structure":
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
    case "user_already_exists":
    case "organization_admin_already_exists":
    case "organization_not_found":
    case "organization_admin_invalid_uuid":
    case "organization_admin_email_empty":
    case "organization_admin_email_too_long":
    case "organization_admin_email_invalid":
      Logger.error(`Internal data inconsistency: ${errorCode}`)
      return new InternalServerErrorException(
        generateErrorPayload("UNKNOWN_ERROR", `${context}: internal data inconsistency`)
      )
    case "oidc_network_error":
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
    case "unknown_error":
      return new InternalServerErrorException(generateErrorPayload(errorCode, `${context}: unknown error`))
    case "request_empty_body":
    case "request_missing_code":
    case "request_invalid_code":
    case "request_missing_state":
    case "request_invalid_state":
    case "auth_user_not_found_in_system":
    case "pkce_code_verification_failed":
    case "pkce_code_not_found":
    case "pkce_code_expired":
    case "pkce_code_already_used":
    case "user_not_found":
      return new BadRequestException(generateErrorPayload(errorCode, `${context}: ${errorCode}`))
    case "pkce_code_concurrency_conflict":
      return new ConflictException(generateErrorPayload(errorCode, `${context}: ${errorCode}`))
    case "requestor_not_authorized":
      return new UnauthorizedException(generateErrorPayload(errorCode, `${context}: ${errorCode}`))
  }
}
