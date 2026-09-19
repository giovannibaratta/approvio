import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {
  AuditLog,
  Organization,
  UserFactory,
  UserValidationError,
  AuthenticatedPlatformSession,
  AuthenticatedEntity,
  AuditLogFactory,
  AuditLogValidationError,
  BoundaryError,
  MembershipStatus,
  OrgRole,
  MutationError,
  OrganizationFactory,
  OrganizationSummaryFactory,
  OrganizationSummaryValidationError,
  OrganizationValidationError,
  TenantContext,
  User
} from "@domain"
import {pipe} from "fp-ts/function"
import {RepositoryDependencyError, UnknownError} from "../error"
import {ConfigProvider} from "@external/config"
import {
  ACCOUNT_DISCOVERY_REPOSITORY_TOKEN,
  AccountDiscoveryRepository,
  LIFECYCLE_REPOSITORY_TOKEN,
  LifecycleRepository,
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository,
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  OrganizationDirectoryRepository,
  ORGANIZATION_PROVISIONER_TOKEN,
  OrganizationProvisioner,
  OrganizationSummary
} from "./interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {PaginationValidationError, validatePagination} from "@utils"
import {AUDIT_LOG_REPOSITORY_TOKEN, AuditLogRepository} from "../audit-log/interfaces"
import {initialOrganizationPlanTier} from "./organization-plan"

export type OrganizationListError =
  "permission_denied" | PaginationValidationError | RepositoryDependencyError | OrganizationSummaryValidationError
export type OrganizationCreateError =
  | MutationError
  | OrganizationValidationError
  | RepositoryDependencyError
  | UserValidationError
  | AuditLogValidationError
  | OrganizationSummaryValidationError
  | TransactionError
  | UnknownError
export type OrganizationGetError =
  OrganizationSummaryValidationError | MutationError | TransactionError | RepositoryDependencyError

export type OrganizationUpdateError =
  | MutationError
  | TransactionError
  | RepositoryDependencyError
  | AuditLogValidationError
  | BoundaryError
  | UnknownError
  | OrganizationSummaryValidationError

@Injectable()
export class OrganizationService {
  private readonly deploymentEdition: ConfigProvider["deploymentEdition"]

  constructor(
    @Inject(ACCOUNT_DISCOVERY_REPOSITORY_TOKEN) private readonly discovery: AccountDiscoveryRepository,
    @Inject(ORGANIZATION_PROVISIONER_TOKEN) private readonly provisioner: OrganizationProvisioner,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN) private readonly directory: OrganizationDirectoryRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager,
    @Inject(ConfigProvider) configProvider: ConfigProvider,
    @Inject(LIFECYCLE_REPOSITORY_TOKEN) private readonly lifecycleRepo: LifecycleRepository,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN) private readonly auditLogRepo: AuditLogRepository,
    @Inject(MEMBERSHIP_REPOSITORY_TOKEN) private readonly membershipRepo: MembershipRepository
  ) {
    this.deploymentEdition = configProvider.deploymentEdition
  }

  getTenantOrganization(context: TenantContext): TE.TaskEither<OrganizationGetError, OrganizationSummary> {
    return this.txManager.execute(context, () => this.directory.get(context))
  }

  update(
    context: TenantContext,
    requestor: AuthenticatedEntity,
    expectedVersion: bigint,
    input: {readonly displayName: string}
  ): TE.TaskEither<OrganizationUpdateError, OrganizationSummary> {
    return this.txManager.execute(context, () => {
      if (
        requestor.entityType !== "user" ||
        requestor.user.organizationId !== context.organizationId ||
        requestor.user.status !== MembershipStatus.ACTIVE ||
        requestor.user.orgRole !== OrgRole.OWNER
      )
        return TE.left("permission_denied")

      const owner = requestor.user
      return pipe(
        this.directory.get(context),
        TE.chainEitherKW(organization => OrganizationSummaryFactory.updateDisplayName(organization, input.displayName)),
        // TODO: This sound weird to update an org via the lifecycle Repo, also why teh previous call did not update the updatedAt ?
        TE.chainW(organization => this.lifecycleRepo.update(context, expectedVersion, organization, new Date())),
        TE.bindTo("updated"),
        TE.bindW("log", ({updated}) =>
          TE.fromEither(
            AuditLogFactory.create({
              organizationId: context.organizationId,
              auditType: "ORGANIZATION_UPDATED",
              entityType: "ORGANIZATION",
              entityId: updated.id,
              actor: {type: "user", id: owner.id, displayName: owner.displayName},
              payload: {displayName: updated.displayName}
            })
          )
        ),
        TE.chainFirstW(({log}) => this.auditLogRepo.persist(context, log)),
        TE.map(({updated}) => updated)
      )
    })
  }

  /** Scan organization metadata across tenants in ID order for bounded background processing. */
  listBatch(
    limit: number,
    afterId?: string
  ): TE.TaskEither<OrganizationSummaryValidationError | RepositoryDependencyError, ReadonlyArray<OrganizationSummary>> {
    return this.directory.listBatch(limit, afterId)
  }

  listOrganizationsForAccount(
    session: AuthenticatedPlatformSession,
    page = 1,
    limit = 20
  ): TE.TaskEither<
    OrganizationListError,
    {
      readonly items: ReadonlyArray<OrganizationSummary>
      readonly total: number
      readonly page: number
      readonly limit: number
    }
  > {
    if (session.account.status !== "active") return TE.left("permission_denied")
    return pipe(
      TE.fromEither(validatePagination(page, limit)),
      TE.chainW(pagination =>
        this.discovery.listOrganizationsForAccount(session.account.id, pagination.page, pagination.limit)
      ),
      TE.map(result => ({...result, page, limit}))
    )
  }

  create(
    session: AuthenticatedPlatformSession,
    input: {readonly slug: string; readonly displayName: string}
  ): TE.TaskEither<OrganizationCreateError, {readonly organization: OrganizationSummary; readonly owner: User}> {
    if (session.account.status !== "active") return TE.left("permission_denied")

    return pipe(
      TE.fromEither(OrganizationFactory.create(input)),
      TE.bindTo("organization"),
      TE.bindW("owner", ({organization}) =>
        TE.fromEither(
          UserFactory.create({
            organizationId: organization.id,
            accountId: session.account.id,
            displayName: "Owner",
            orgRole: OrgRole.OWNER
          })
        )
      ),
      TE.bindW("audit", ({organization, owner}) =>
        TE.fromEither(
          AuditLogFactory.create({
            organizationId: organization.id,
            auditType: "ORGANIZATION_CREATED",
            entityType: "ORGANIZATION",
            entityId: organization.id,
            actor: {type: "user", id: owner.id, displayName: owner.displayName},
            payload: {
              slug: organization.slug,
              displayName: organization.displayName,
              initialOwnerAccountId: owner.accountId
            }
          })
        )
      ),
      TE.chainW(({organization, owner, audit}) => this.provision(organization, owner, audit))
    )
  }

  /** Persists validated setup entities and their audit record in the tenant transaction. */
  provision(
    organization: Organization,
    owner: User,
    audit: AuditLog
  ): TE.TaskEither<OrganizationCreateError, {readonly organization: OrganizationSummary; readonly owner: User}> {
    const context = {organizationId: organization.id}
    return this.txManager.execute(context, () =>
      pipe(
        this.provisioner.createOrganization(organization, initialOrganizationPlanTier(this.deploymentEdition)),
        TE.chainFirstW(() => this.membershipRepo.create(owner)),
        TE.chainFirstW(() => this.auditLogRepo.persist(context, audit)),
        TE.map(organization => ({organization, owner}))
      )
    )
  }
}
