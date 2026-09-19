import {TaskEither} from "fp-ts/TaskEither"
import {
  Account,
  AccountValidationError,
  AuthorityError,
  BoundaryError,
  Invitation,
  InvitationValidationError,
  Versioned,
  MutationError,
  Organization,
  OrganizationSummary,
  OrganizationSummaryValidationError,
  OrganizationValidationError,
  OrgStatus,
  PlanTier,
  Session,
  SessionState,
  SessionValidationError,
  StepUpReceipt,
  StepUpReceiptValidationError,
  ConsumedStepUpReceipt,
  TenantContext,
  User,
  UserValidationError
} from "@domain"
import {RepositoryDependencyError} from "../error"
import {TransactionError} from "../transaction/interfaces"
import {AgentGetError} from "../agent/interfaces"

export type {OrganizationSummary} from "@domain"

export type OrganizationStatusError = BoundaryError | "organization_not_found" | RepositoryDependencyError

/** Reads persisted organization status in the caller's tenant transaction; does not authorize an operation. */
export interface OrganizationStatusRepository {
  getStatus(context: TenantContext): TaskEither<OrganizationStatusError, OrgStatus>
}
export const ORGANIZATION_STATUS_REPOSITORY_TOKEN = Symbol("ORGANIZATION_STATUS_REPOSITORY_TOKEN")

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

export interface PlatformIdentityRepository {
  resolveIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
  }): TaskEither<BoundaryError | AccountValidationError | "account_not_found" | RepositoryDependencyError, Account>
  createIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
    readonly account: Account
  }): TaskEither<BoundaryError | AccountValidationError | "identity_exists" | RepositoryDependencyError, Account>
  getAccountById(
    accountId: string
  ): TaskEither<BoundaryError | AccountValidationError | "account_not_found" | RepositoryDependencyError, Account>
}
export const PLATFORM_IDENTITY_REPOSITORY_TOKEN = "PLATFORM_IDENTITY_REPOSITORY_TOKEN"

export interface AccountDiscoveryRepository {
  listOrganizationsForAccount(
    accountId: string,
    page: number,
    limit: number
  ): TaskEither<
    RepositoryDependencyError | OrganizationSummaryValidationError,
    {readonly items: ReadonlyArray<OrganizationSummary>; readonly total: number}
  >
}
export const ACCOUNT_DISCOVERY_REPOSITORY_TOKEN = "ACCOUNT_DISCOVERY_REPOSITORY_TOKEN"

export type SessionRepositoryError = SessionValidationError | "session_not_found" | RepositoryDependencyError

export interface SessionRepository {
  create(session: SessionState): TaskEither<SessionValidationError | RepositoryDependencyError, Session>
  getByAccountAndPrincipal(accountId: string, sessionId: string): TaskEither<SessionRepositoryError, Session>

  /** Compare-and-swap prevents a late response from restoring a stale selected organization. */
  updateContext(
    session: Session
  ): TaskEither<SessionValidationError | "concurrent_modification_error" | RepositoryDependencyError, Session>

  /** Revoke only a matching active session; session_not_found means no active row matched. */
  revokeActiveByAccountAndId(
    accountId: string,
    sessionId: string
  ): TaskEither<"session_not_found" | RepositoryDependencyError, void>
}
export const SESSION_REPOSITORY_TOKEN = "SESSION_REPOSITORY_TOKEN"

export interface OrganizationDirectoryRepository {
  get(
    context: TenantContext
  ): TaskEither<
    BoundaryError | "organization_not_found" | OrganizationSummaryValidationError | RepositoryDependencyError,
    OrganizationSummary
  >

  /** Highest organization ID in database order; undefined when no organization matches status. */
  getLastOrganizationId(status?: OrgStatus): TaskEither<RepositoryDependencyError, string | undefined>

  /**
   * Platform-only bounded scan used to enqueue lifecycle work without granting tenant-data access.
   * @param afterId Exclusive organization-ID cursor; omit it to start the scan. Results are ordered by
   * ID ascending. Pass the last returned ID to read the next batch; an empty batch ends the scan.
   * When supplied, status filters organizations before pagination.
   * throughId is an inclusive upper bound captured by the caller to keep a scan from following new IDs.
   */
  listBatch(
    limit: number,
    afterId?: string,
    status?: OrgStatus,
    throughId?: string
  ): TaskEither<OrganizationSummaryValidationError | RepositoryDependencyError, ReadonlyArray<OrganizationSummary>>
}

export const ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN = Symbol("ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN")

export interface OrganizationEntitlementRepository {
  getPlanTier(context: TenantContext): TaskEither<"organization_not_found" | RepositoryDependencyError, PlanTier>
}

export const ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN = Symbol("ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN")
export type OrganizationPlanTierError = "organization_not_found" | RepositoryDependencyError | TransactionError

export interface OrganizationProvisioner {
  createOrganization(
    organization: Organization,
    planTier: PlanTier
  ): TaskEither<MutationError | OrganizationSummaryValidationError | RepositoryDependencyError, OrganizationSummary>
}
export const ORGANIZATION_PROVISIONER_TOKEN = "ORGANIZATION_PROVISIONER_TOKEN"

export interface MembershipRepository {
  getByAccount(
    context: TenantContext,
    accountId: string
  ): TaskEither<MutationError | UserValidationError | RepositoryDependencyError, VersionedMembership>
  getById(
    context: TenantContext,
    userId: string
  ): TaskEither<MutationError | UserValidationError | RepositoryDependencyError, VersionedMembership>
  list(
    context: TenantContext,
    page: number,
    limit: number
  ): TaskEither<
    MutationError | UserValidationError | RepositoryDependencyError,
    {readonly items: ReadonlyArray<VersionedMembership>; readonly total: number}
  >
  create(
    membership: User
  ): TaskEither<MutationError | UserValidationError | RepositoryDependencyError, VersionedMembership>
  update(
    context: TenantContext,
    previous: VersionedMembership,
    membership: User
  ): TaskEither<MutationError | UserValidationError | RepositoryDependencyError, VersionedMembership>
  countActiveOwners(context: TenantContext): TaskEither<RepositoryDependencyError, number>
}
export const MEMBERSHIP_REPOSITORY_TOKEN = "MEMBERSHIP_REPOSITORY_TOKEN"

export interface VersionedMembership {
  readonly membership: User
  readonly occ: bigint
}

export interface InvitationRepository {
  create(invitation: Invitation): TaskEither<MutationError | RepositoryDependencyError, void>
  getById(
    context: TenantContext,
    invitationId: string
  ): TaskEither<MutationError | InvitationValidationError | RepositoryDependencyError, Versioned<Invitation>>
  /** Caller validates the transition through InvitationFactory; persistence guards tenant identity and OCC. */
  persist(
    context: TenantContext,
    invitation: Invitation,
    expectedOcc: bigint
  ): TaskEither<MutationError | RepositoryDependencyError, void>
}
export const INVITATION_REPOSITORY_TOKEN = "INVITATION_REPOSITORY_TOKEN"

export interface StepUpReceiptRepository {
  issue(receipt: StepUpReceipt): TaskEither<"resource_already_exists" | RepositoryDependencyError, void>
  get(
    context: TenantContext,
    jti: string
  ): TaskEither<StepUpReceiptValidationError | "resource_not_found" | RepositoryDependencyError, StepUpReceipt>
  markConsumed(
    context: TenantContext,
    receipt: ConsumedStepUpReceipt
  ): TaskEither<"concurrent_modification_error" | RepositoryDependencyError, void>
}
export const STEP_UP_RECEIPT_REPOSITORY_TOKEN = "STEP_UP_RECEIPT_REPOSITORY_TOKEN"

export interface LifecycleRepository {
  getSummary(
    context: TenantContext
  ): TaskEither<MutationError | OrganizationSummaryValidationError | RepositoryDependencyError, OrganizationSummary>
  update(
    context: TenantContext,
    expectedVersion: bigint,
    organization: OrganizationSummary,
    updatedAt: Date
  ): TaskEither<MutationError | OrganizationSummaryValidationError | RepositoryDependencyError, OrganizationSummary>
  get(
    context: TenantContext
  ): TaskEither<MutationError | RepositoryDependencyError | OrganizationValidationError, Versioned<Organization>>
  persistTransition(
    context: TenantContext,
    expectedVersion: bigint,
    organization: Organization
  ): TaskEither<MutationError | OrganizationSummaryValidationError | RepositoryDependencyError, OrganizationSummary>
}
export const LIFECYCLE_REPOSITORY_TOKEN = "LIFECYCLE_REPOSITORY_TOKEN"
