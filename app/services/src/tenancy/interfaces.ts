import {TaskEither} from "fp-ts/TaskEither"
import {
  Account,
  AuthorityError,
  BoundaryError,
  Invitation,
  Versioned,
  MutationError,
  Organization,
  OrganizationSummary,
  OrganizationValidationError,
  OrgStatus,
  PlanTier,
  Session,
  SessionState,
  StepUpReceipt,
  StepUpReceiptState,
  ConsumedStepUpReceipt,
  TenantContext,
  User
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
  }): TaskEither<BoundaryError | "account_not_found" | RepositoryDependencyError, Account>
  createIdentity(input: {
    readonly providerId: string
    readonly issuer: string
    readonly subject: string
    readonly account: Account
  }): TaskEither<BoundaryError | "identity_exists" | RepositoryDependencyError, Account>
  getAccountById(
    accountId: string
  ): TaskEither<BoundaryError | "account_not_found" | RepositoryDependencyError, Account>
}
export const PLATFORM_IDENTITY_REPOSITORY_TOKEN = "PLATFORM_IDENTITY_REPOSITORY_TOKEN"

export interface AccountDiscoveryRepository {
  listOrganizationsForAccount(
    accountId: string,
    page: number,
    limit: number
  ): TaskEither<RepositoryDependencyError, {readonly items: ReadonlyArray<OrganizationSummary>; readonly total: number}>
}
export const ACCOUNT_DISCOVERY_REPOSITORY_TOKEN = "ACCOUNT_DISCOVERY_REPOSITORY_TOKEN"

export interface SessionRepository {
  create(session: SessionState): TaskEither<RepositoryDependencyError, Session>
  getByAccountAndPrincipal(
    accountId: string,
    sessionId: string
  ): TaskEither<AuthorityError | RepositoryDependencyError, Session>

  /** Compare-and-swap prevents a late response from restoring a stale selected organization. */
  updateContext(session: Session): TaskEither<AuthorityError | RepositoryDependencyError, Session>
  revokeByAccountAndId(
    accountId: string,
    sessionId: string
  ): TaskEither<AuthorityError | RepositoryDependencyError, void>
}
export const SESSION_REPOSITORY_TOKEN = "SESSION_REPOSITORY_TOKEN"

export interface OrganizationDirectoryRepository {
  get(
    context: TenantContext
  ): TaskEither<BoundaryError | "organization_not_found" | RepositoryDependencyError, OrganizationSummary>

  /**
   * Platform-only bounded scan used to enqueue lifecycle work without granting tenant-data access.
   * @param afterId Exclusive organization-ID cursor; omit it to start the scan. Results are ordered by
   * ID ascending. Pass the last returned ID to read the next batch; an empty batch ends the scan.
   */
  listBatch(limit: number, afterId?: string): TaskEither<RepositoryDependencyError, ReadonlyArray<OrganizationSummary>>
}

export const ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN = Symbol("ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN")

export interface OrganizationEntitlementRepository {
  getPlanTier(context: TenantContext): TaskEither<"organization_not_found" | RepositoryDependencyError, PlanTier>
}

export const ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN = Symbol("ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN")
export type OrganizationPlanTierError = "organization_not_found" | RepositoryDependencyError | TransactionError

export interface OrganizationProvisioner {
  createOrganization(
    context: TenantContext,
    organization: Organization,
    planTier: PlanTier
  ): TaskEither<MutationError | RepositoryDependencyError, void>
  createOwner(context: TenantContext, owner: User): TaskEither<MutationError | RepositoryDependencyError, void>
}
export const ORGANIZATION_PROVISIONER_TOKEN = "ORGANIZATION_PROVISIONER_TOKEN"

export interface MembershipRepository {
  getByAccount(
    context: TenantContext,
    accountId: string
  ): TaskEither<MutationError | RepositoryDependencyError, VersionedMembership>
  getById(
    context: TenantContext,
    userId: string
  ): TaskEither<MutationError | RepositoryDependencyError, VersionedMembership>
  list(
    context: TenantContext,
    page: number,
    limit: number
  ): TaskEither<
    MutationError | RepositoryDependencyError,
    {readonly items: ReadonlyArray<VersionedMembership>; readonly total: number}
  >
  create(
    context: TenantContext,
    membership: User
  ): TaskEither<MutationError | RepositoryDependencyError, VersionedMembership>
  update(
    context: TenantContext,
    previous: VersionedMembership,
    membership: User
  ): TaskEither<MutationError | RepositoryDependencyError, VersionedMembership>
  countActiveOwners(context: TenantContext): TaskEither<RepositoryDependencyError, number>
}
export const MEMBERSHIP_REPOSITORY_TOKEN = "MEMBERSHIP_REPOSITORY_TOKEN"

export interface VersionedMembership {
  readonly membership: User
  readonly occ: string
}

export interface InvitationRepository {
  create(context: TenantContext, invitation: Invitation): TaskEither<MutationError | RepositoryDependencyError, void>
  getById(
    context: TenantContext,
    invitationId: string
  ): TaskEither<MutationError | RepositoryDependencyError, Versioned<Invitation>>
  persist(
    context: TenantContext,
    invitation: Invitation,
    expectedOcc: bigint
  ): TaskEither<MutationError | RepositoryDependencyError, void>
}
export const INVITATION_REPOSITORY_TOKEN = "INVITATION_REPOSITORY_TOKEN"

export interface StepUpReceiptRepository {
  issue(context: TenantContext, receipt: StepUpReceipt): TaskEither<AuthorityError | RepositoryDependencyError, void>
  get(context: TenantContext, jti: string): TaskEither<AuthorityError | RepositoryDependencyError, StepUpReceiptState>
  persist(
    context: TenantContext,
    receipt: ConsumedStepUpReceipt
  ): TaskEither<AuthorityError | RepositoryDependencyError, void>
}
export const STEP_UP_RECEIPT_REPOSITORY_TOKEN = "STEP_UP_RECEIPT_REPOSITORY_TOKEN"

export interface LifecycleRepository {
  getSummary(context: TenantContext): TaskEither<MutationError | RepositoryDependencyError, OrganizationSummary>
  update(
    context: TenantContext,
    expectedVersion: bigint,
    organization: OrganizationSummary
  ): TaskEither<MutationError | RepositoryDependencyError, OrganizationSummary>
  get(
    context: TenantContext
  ): TaskEither<MutationError | RepositoryDependencyError | OrganizationValidationError, Versioned<Organization>>
  persistTransition(
    context: TenantContext,
    expectedVersion: bigint,
    organization: Organization
  ): TaskEither<MutationError | RepositoryDependencyError, OrganizationSummary>
}
export const LIFECYCLE_REPOSITORY_TOKEN = "LIFECYCLE_REPOSITORY_TOKEN"
