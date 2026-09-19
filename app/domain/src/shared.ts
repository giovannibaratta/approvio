export type Versioned<T> = T & {
  readonly occ: bigint
}

export interface TenantContext {
  readonly organizationId: string
}

export type TenantOwned<T> = T & TenantContext

export type OrgStatus = "active" | "suspended" | "deleting" | "deleted"
export type SuspensionReason = "owner_requested" | "security" | "abuse" | "payment" | "operator"

/** Failures at the request-to-tenant boundary: invalid, missing, or mismatched context. */
export type BoundaryError = "invalid_organization_id" | "tenant_context_required" | "organization_mismatch"

/** Infrastructure failures exposed by the transaction boundary */
export type TransactionError =
  | BoundaryError
  | "conflicting_isolation_level"
  | "retry_exhausted"
  | "commit_outcome_unknown"
  | "storage_unavailable"
  | "concurrency_error"

export type AuthorityError =
  | BoundaryError
  | "invalid_credential"
  | "organization_not_found"
  | "organization_context_changed"
  | "organization_suspended"
  | "organization_deleting"
  | "permission_denied"
  | "step_up_required"
  | "step_up_invalid"
  | "step_up_consumed"

export type MutationError =
  | AuthorityError
  | "invalid_reference"
  | "resource_not_found"
  | "resource_already_exists"
  | "resource_in_use"
  | "concurrent_modification_error"
  /** The mutation would leave the organization without an active owner. */
  | "organization_owner_required"
  | "invalid_transition"
  | "quota_exceeded"
  | "invitation_invalid"
