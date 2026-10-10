import {
  InvitationCreate,
  InvitationCreated,
  Membership,
  OrganizationModelValidationError,
  validateInvitationCreated,
  validateMembership
} from "@approvio/api"
import {HttpException, HttpStatus} from "@nestjs/common"
import {CreateInvitationRequest, InvitationManagementError} from "@services"
import {AuthenticatedEntity, OrgRole, TenantContext, User} from "@domain"
import {getStringAsEnum} from "@utils"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {generateErrorPayload} from "../error"

export type InvitationControllerError =
  | InvitationManagementError
  | OrganizationModelValidationError
  | "invalid_invitation_role"
  | "malformed_creation_response"
  | "malformed_acceptance_response"

export function mapInvitationCreateInput(input: {
  readonly invitation: InvitationCreate
  readonly context: TenantContext
  readonly requestor: AuthenticatedEntity
}): E.Either<"invalid_invitation_role", CreateInvitationRequest> {
  const orgRole = getStringAsEnum(input.invitation.orgRole, OrgRole)
  if (!orgRole) return E.left("invalid_invitation_role")
  return E.right({
    accountId: input.invitation.accountId,
    orgRole,
    context: input.context,
    requestor: input.requestor
  })
}

export function mapCreatedInvitation(invitation: {
  readonly id: string
  readonly expiresAt: Date
  readonly token: string
}): E.Either<"malformed_creation_response", InvitationCreated> {
  return pipe(
    validateInvitationCreated({
      id: invitation.id,
      expiresAt: invitation.expiresAt.toISOString(),
      token: invitation.token
    }),
    E.mapLeft((): "malformed_creation_response" => "malformed_creation_response")
  )
}

export function mapAcceptedInvitation(user: User): E.Either<"malformed_acceptance_response", Membership> {
  return pipe(
    validateMembership({
      id: user.id,
      organizationId: user.organizationId,
      accountId: user.accountId,
      displayName: user.displayName,
      status: user.status,
      orgRole: user.orgRole
    }),
    E.mapLeft((): "malformed_acceptance_response" => "malformed_acceptance_response")
  )
}
export function generateErrorResponseForInvitation(error: InvitationControllerError): HttpException {
  switch (error) {
    case "user_invalid_membership_transition":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Invalid membership transition"),
        HttpStatus.CONFLICT
      )
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
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Invalid domain state"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )

    case "malformed_object":
    case "missing_field":
    case "invalid_field":
      return new HttpException(
        generateErrorPayload("INVALID_INVITATION", "Invitation request is invalid"),
        HttpStatus.BAD_REQUEST
      )
    case "invalid_invitation_role":
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Invalid invitation role from API contract"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    case "malformed_creation_response":
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Invalid invitation creation response"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    case "malformed_acceptance_response":
      return new HttpException(
        generateErrorPayload("UNKNOWN_ERROR", "Invalid invitation acceptance response"),
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    case "invitation_invalid_account_id":
    case "invitation_invalid_id":
    case "invitation_invalid_inviter_id":
    case "invitation_invalid_organization_id":
    case "invitation_invalid_token_hash":
    case "invitation_expiry_required":
    case "invitation_invalid_status":
    case "invitation_invalid_transition_timestamp":
      return new HttpException(
        generateErrorPayload(error.toUpperCase(), "Invitation validation failed"),
        HttpStatus.BAD_REQUEST
      )
    case "invalid_reference":
      return new HttpException(
        generateErrorPayload("INVALID_INVITATION", "Invitation reference is invalid"),
        HttpStatus.BAD_REQUEST
      )
    case "permission_denied":
      return new HttpException(
        generateErrorPayload("PERMISSION_DENIED", "Organization manager access is required"),
        HttpStatus.FORBIDDEN
      )
    case "invitation_invalid":
    case "resource_not_found":
      return new HttpException(
        generateErrorPayload("INVITATION_INVALID", "Invitation is invalid"),
        HttpStatus.NOT_FOUND
      )
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Invitations are disabled while the organization is suspended"),
        HttpStatus.LOCKED
      )
    case "concurrent_modification_error":
      return new HttpException(
        generateErrorPayload("CONCURRENT_MODIFICATION_ERROR", "Invitation changed during the operation"),
        HttpStatus.CONFLICT
      )
    case "resource_already_exists":
      return new HttpException(
        generateErrorPayload("INVITATION_EXISTS", "Invitation could not be created"),
        HttpStatus.CONFLICT
      )
    case "membership_already_active":
      return new HttpException(
        generateErrorPayload("MEMBERSHIP_ALREADY_ACTIVE", "Account already has an active organization membership"),
        HttpStatus.CONFLICT
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "invalid_credential":
    case "organization_not_found":
    case "organization_context_changed":
    case "organization_deleting":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "resource_in_use":
    case "organization_owner_required":
    case "invalid_transition":
    case "quota_exceeded":
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
      return new HttpException(
        generateErrorPayload("STORAGE_UNAVAILABLE", "Invitation operation is unavailable"),
        HttpStatus.SERVICE_UNAVAILABLE
      )
  }
}
