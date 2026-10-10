import {Injectable, Logger} from "@nestjs/common"
import {AccountDiscoveryRepository, OrganizationSummary, RepositoryDependencyError} from "@services"
import {OrganizationSummaryFactory} from "@domain"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {DiscoveryDatabaseClient} from "./capability-database-client"

@Injectable()
export class AccountDiscoveryDbRepository implements AccountDiscoveryRepository {
  constructor(private readonly discovery: DiscoveryDatabaseClient) {}

  listOrganizationsForAccount(
    accountId: string,
    page: number,
    limit: number
  ): TE.TaskEither<
    RepositoryDependencyError,
    {readonly items: ReadonlyArray<OrganizationSummary>; readonly total: number}
  > {
    return TE.tryCatch(
      async () =>
        this.discovery.transactional(async tx => {
          const where = {platformAccountId: accountId, status: "active"}
          const [memberships, total] = await Promise.all([
            tx.user.findMany({
              where,
              orderBy: {organizationId: "asc"},
              skip: (page - 1) * limit,
              take: limit,
              select: {
                organizations: {select: {id: true, slug: true, displayName: true, status: true, occ: true}}
              }
            }),
            tx.user.count({where})
          ])

          return {
            items: memberships.map(({organizations}) => mapOrganization(organizations)),
            total
          }
        }),
      error => {
        Logger.error(
          "Account discovery repository list_organizations_for_account failed",
          error instanceof Error ? error.name : "non_error"
        )
        return "repository_dependency_error"
      }
    )
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
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    status: organization.status,
    occ: organization.occ
  })
  if (E.isLeft(summary)) throw new Error("Invalid organization summary returned by persistence")
  return summary.right
}
