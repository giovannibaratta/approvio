import {Membership} from "@approvio/api"
import {OrgRole, User} from "@domain"
import {HttpException, HttpStatus, PreconditionFailedException} from "@nestjs/common"
import {MembershipManagementError} from "@services"
import * as E from "fp-ts/Either"
import {generateErrorPayload} from "../error"

export type MembershipControllerError =
  MembershipManagementError | "invalid_pagination" | "invalid_membership" | "invalid_etag"

// TODO: Don't we have a validator from the Approvio API ?
export function validateMembershipRole(body: unknown): E.Either<"invalid_membership", OrgRole> {
  if (typeof body !== "object" || body === null || !("orgRole" in body) || typeof body.orgRole !== "string")
    return E.left("invalid_membership")
  const role = Object.values(OrgRole).find(role => role === body.orgRole)
  return role === undefined ? E.left("invalid_membership") : E.right(role)
}

export function mapMembership(user: User): Membership {
  return {
    id: user.id,
    organizationId: user.organizationId,
    accountId: user.accountId,
    displayName: user.displayName,
    status: user.status,
    orgRole: user.orgRole
  }
}

export function generateErrorResponseForMembership(error: MembershipControllerError): HttpException {
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

    case "invalid_pagination":
    case "invalid_page_number":
    case "invalid_limit_number":
      return new HttpException(
        generateErrorPayload("INVALID_PAGINATION", "Invalid page or limit"),
        HttpStatus.BAD_REQUEST
      )
    case "invalid_membership":
      return new HttpException(
        generateErrorPayload("INVALID_MEMBERSHIP", "orgRole is required"),
        HttpStatus.BAD_REQUEST
      )
    case "invalid_etag":
      return new PreconditionFailedException(
        generateErrorPayload("INVALID_ETAG", "If-Match must be a current membership tag")
      )
    case "invalid_reference":
      return new HttpException(
        generateErrorPayload("INVALID_MEMBERSHIP", "Membership reference is invalid"),
        HttpStatus.BAD_REQUEST
      )
    case "permission_denied":
      return new HttpException(
        generateErrorPayload("PERMISSION_DENIED", "Organization manager access is required"),
        HttpStatus.FORBIDDEN
      )
    case "resource_not_found":
    case "organization_not_found":
    case "organization_deleting":
      return new HttpException(
        generateErrorPayload("MEMBERSHIP_NOT_FOUND", "Membership not found"),
        HttpStatus.NOT_FOUND
      )
    case "organization_owner_required":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_OWNER_REQUIRED", "The organization must retain an active owner"),
        HttpStatus.CONFLICT
      )
    case "concurrent_modification_error":
      return new PreconditionFailedException(generateErrorPayload("STALE_ETAG", "Membership has changed"))
    case "organization_suspended":
      return new HttpException(
        generateErrorPayload("ORGANIZATION_SUSPENDED", "Organization membership changes are restricted"),
        HttpStatus.LOCKED
      )
    case "invalid_organization_id":
    case "tenant_context_required":
    case "organization_mismatch":
    case "invalid_credential":
    case "organization_context_changed":
    case "step_up_required":
    case "step_up_invalid":
    case "step_up_consumed":
    case "resource_already_exists":
    case "resource_in_use":
    case "invalid_transition":
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
        generateErrorPayload("STORAGE_UNAVAILABLE", "Membership operation is unavailable"),
        HttpStatus.SERVICE_UNAVAILABLE
      )
  }
}
