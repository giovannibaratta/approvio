import {fromEitherPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {AccountDiscoveryRepository, OrganizationSummary, RepositoryDependencyError} from "@services"
import {OrganizationSummaryFactory, OrganizationSummaryValidationError} from "@domain"
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
    RepositoryDependencyError | OrganizationSummaryValidationError,
    {readonly items: ReadonlyArray<OrganizationSummary>; readonly total: number}
  > {
    return fromEitherPromise(
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

          return E.map((items: ReadonlyArray<OrganizationSummary>) => ({items, total}))(
            E.sequenceArray(memberships.map(({organizations}) => mapOrganization(organizations)))
          )
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
}): E.Either<OrganizationSummaryValidationError, OrganizationSummary> {
  return OrganizationSummaryFactory.validate({
    id: organization.id,
    slug: organization.slug,
    displayName: organization.displayName,
    status: organization.status,
    occ: organization.occ
  })
}
