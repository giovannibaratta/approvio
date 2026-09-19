import {fromPromise, fromEitherPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {OrganizationSummaryFactory, OrganizationSummaryValidationError, OrgStatus, TenantContext} from "@domain"
import {OrganizationDirectoryRepository, OrganizationSummary, RepositoryDependencyError} from "@services"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {chainNullableToLeft} from "./utils"
import {OrganizationDirectoryTenantClient} from "./tenant-database-clients"
import {SchedulerDatabaseClient} from "./capability-database-client"

@Injectable()
export class OrganizationDirectoryDbRepository implements OrganizationDirectoryRepository {
  constructor(
    private readonly dbClient: OrganizationDirectoryTenantClient,
    private readonly scheduler: SchedulerDatabaseClient
  ) {}

  get(
    context: TenantContext
  ): TE.TaskEither<
    "organization_not_found" | OrganizationSummaryValidationError | RepositoryDependencyError,
    OrganizationSummary
  > {
    return pipe(
      fromPromise(
        () => this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}}),
        error => this.mapError(error, "get")
      ),
      chainNullableToLeft("organization_not_found" as const),
      TE.chainEitherKW(mapOrganization)
    )
  }

  getLastOrganizationId(status?: OrgStatus): TE.TaskEither<RepositoryDependencyError, string | undefined> {
    return fromPromise(
      () =>
        this.scheduler.transactional(async tx => {
          const organization = await tx.organization.findFirst({
            where: {status},
            orderBy: {id: "desc"},
            select: {id: true}
          })
          return organization?.id
        }),
      error => this.mapError(error, "get_last_organization_id")
    )
  }

  listBatch(
    limit: number,
    afterId?: string,
    status?: OrgStatus,
    throughId?: string
  ): TE.TaskEither<OrganizationSummaryValidationError | RepositoryDependencyError, ReadonlyArray<OrganizationSummary>> {
    return fromEitherPromise(
      async () =>
        this.scheduler.transactional(async tx => {
          const organizations = await tx.organization.findMany({
            where: {status, id: {gt: afterId, lte: throughId}},
            orderBy: {id: "asc"},
            take: limit
          })
          return E.traverseArray(mapOrganization)(organizations)
        }),
      error => this.mapError(error, "list_batch")
    )
  }

  private mapError(error: unknown, operation: string): RepositoryDependencyError {
    Logger.error(`Organization directory repository ${operation} failed`, error)
    return "repository_dependency_error"
  }
}

function mapOrganization(organization: {
  id: string
  slug: string
  displayName: string
  status: string
  occ: bigint
}): E.Either<OrganizationSummaryValidationError, OrganizationSummary> {
  return OrganizationSummaryFactory.validate(organization)
}
