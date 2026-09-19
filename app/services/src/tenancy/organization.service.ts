import {Inject, Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {
  AuthenticatedPlatformSession,
  MutationError,
  OrganizationFactory,
  OrganizationValidationError,
  TenantContext,
  User
} from "@domain"
import {pipe} from "fp-ts/function"
import {RepositoryDependencyError} from "../error"
import {ConfigProvider} from "@external/config"
import {
  ACCOUNT_DISCOVERY_REPOSITORY_TOKEN,
  AccountDiscoveryRepository,
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  OrganizationDirectoryRepository,
  ORGANIZATION_PROVISIONER_TOKEN,
  OrganizationProvisioner,
  OrganizationSummary
} from "./interfaces"
import {TRANSACTION_MANAGER_TOKEN, TenantTransactionManager, TransactionError} from "../transaction/interfaces"
import {PaginationValidationError, validatePagination} from "@utils"
import {initialOrganizationPlanTier} from "./organization-plan"

export type OrganizationListError = "permission_denied" | PaginationValidationError | RepositoryDependencyError
export type OrganizationCreateError = MutationError | OrganizationValidationError | RepositoryDependencyError
export type OrganizationGetError = MutationError | TransactionError | RepositoryDependencyError

@Injectable()
export class OrganizationService {
  private readonly deploymentEdition: ConfigProvider["deploymentEdition"]

  constructor(
    @Inject(ACCOUNT_DISCOVERY_REPOSITORY_TOKEN) private readonly discovery: AccountDiscoveryRepository,
    @Inject(ORGANIZATION_PROVISIONER_TOKEN) private readonly provisioner: OrganizationProvisioner,
    @Inject(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN) private readonly directory: OrganizationDirectoryRepository,
    @Inject(TRANSACTION_MANAGER_TOKEN) private readonly txManager: TenantTransactionManager,
    @Inject(ConfigProvider) configProvider: ConfigProvider
  ) {
    this.deploymentEdition = configProvider.deploymentEdition
  }

  getTenantOrganization(context: TenantContext): TE.TaskEither<OrganizationGetError, OrganizationSummary> {
    return this.txManager.execute(context, () => this.directory.get(context))
  }

  /** Scan organization metadata across tenants in ID order for bounded background processing. */
  listBatch(
    afterId: string | null,
    limit: number
  ): TE.TaskEither<RepositoryDependencyError, ReadonlyArray<OrganizationSummary>> {
    return this.directory.listBatch(afterId, limit)
  }

  listForAccount(
    session: AuthenticatedPlatformSession,
    page: number,
    limit: number
  ): TE.TaskEither<
    OrganizationListError,
    {readonly items: ReadonlyArray<OrganizationSummary>; readonly total: number}
  > {
    if (session.account.status !== "active") return TE.left("permission_denied")
    return pipe(
      TE.fromEither(validatePagination(page, limit)),
      TE.chainW(pagination => this.discovery.listForAccount(session.account.id, pagination.page, pagination.limit))
    )
  }

  create(
    session: AuthenticatedPlatformSession,
    input: {readonly slug: string; readonly displayName: string}
  ): TE.TaskEither<OrganizationCreateError, {readonly organization: OrganizationSummary; readonly owner: User}> {
    if (session.account.status !== "active") return TE.left("permission_denied")

    return pipe(
      TE.fromEither(OrganizationFactory.create(input)),
      TE.chainW(organization =>
        this.provisioner.create(session.account.id, {
          organization,
          planTier: initialOrganizationPlanTier(this.deploymentEdition)
        })
      )
    )
  }
}
