import {Injectable, Logger} from "@nestjs/common"
import {OrganizationSummaryFactory, TenantContext} from "@domain"
import {OrganizationDirectoryRepository, OrganizationSummary, RepositoryDependencyError} from "@services"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
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
  ): TE.TaskEither<"organization_not_found" | RepositoryDependencyError, OrganizationSummary> {
    return TE.tryCatch(
      async () => {
        const organization = await this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}})
        if (!organization) throw new OrganizationNotFoundError()
        return mapOrganization(organization)
      },
      error => this.mapError(error, "get")
    )
  }

  listBatch(
    limit: number,
    afterId?: string
  ): TE.TaskEither<RepositoryDependencyError, ReadonlyArray<OrganizationSummary>> {
    return TE.tryCatch(
      async () =>
        this.scheduler.transactional(async tx => {
          const organizations = await tx.organization.findMany({
            where: afterId ? {id: {gt: afterId}} : undefined,
            orderBy: {id: "asc"},
            take: limit
          })
          return organizations.map(mapOrganization)
        }),
      error => this.mapSchedulerError(error, "list_batch")
    )
  }

  private mapError(error: unknown, operation: string): "organization_not_found" | RepositoryDependencyError {
    if (error instanceof OrganizationNotFoundError) return "organization_not_found"
    Logger.error(
      `Organization directory repository ${operation} failed`,
      error instanceof Error ? error.name : "non_error"
    )
    return "repository_dependency_error"
  }

  private mapSchedulerError(error: unknown, operation: string): RepositoryDependencyError {
    Logger.error(
      `Organization directory repository ${operation} failed`,
      error instanceof Error ? error.name : "non_error"
    )
    return "repository_dependency_error"
  }
}

function mapOrganization(organization: {
  id: string
  slug: string
  displayName: string
  status: string
  occ: bigint
}): OrganizationSummary {
  if (
    organization.status !== "active" &&
    organization.status !== "suspended" &&
    organization.status !== "deleting" &&
    organization.status !== "deleted"
  )
    throw new Error("Invalid organization status")

  const summary = OrganizationSummaryFactory.validate({
    ...organization,
    status: organization.status,
    occ: organization.occ
  })
  if (E.isLeft(summary)) throw new Error("Invalid organization summary returned by persistence")
  return summary.right
}

class OrganizationNotFoundError extends Error {}
