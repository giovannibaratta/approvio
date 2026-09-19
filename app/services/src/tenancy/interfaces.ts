import {TaskEither} from "fp-ts/TaskEither"
import {
  Account,
  Actor,
  AuditLogValidationError,
  AuditLog,
  AuthorityError,
  BoundaryError,
  Invitation,
  MutationError,
  Organization,
  OrganizationId,
  OrganizationSummary,
  PlatformSecurityEventValidationError,
  OrgRole,
  PlanTier,
  Session,
  StepUpReceipt,
  StepUpReceiptState,
  ConsumedStepUpReceipt,
  SuspensionReason,
  TenantContext,
  User
} from "@domain"
import {RepositoryDependencyError, UnknownError} from "../error"
import {TransactionError} from "../transaction/interfaces"
import {AgentGetError} from "../agent/interfaces"

export type {OrganizationSummary} from "@domain"

export type TenantOperationError =
  | "invalid_organization_id"
  | "tenant_context_required"
  | "organization_mismatch"
  | AuthorityError
  | BoundaryError
  | MutationError
  | RepositoryDependencyError
  | TransactionError
  | AgentGetError
  | "account_not_found"
  readonly id: OrganizationId
  readonly slug: string
  readonly displayName: string
  readonly status: OrgStatus
  readonly occ: string
}
