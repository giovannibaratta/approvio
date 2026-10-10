import {isPlanTier, PlanTier, TenantContext} from "@domain"
import {OrganizationEntitlementRepository, RepositoryDependencyError} from "@services"
import {Injectable, Logger} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {OrganizationDirectoryTenantClient} from "./tenant-database-clients"

@Injectable()
export class OrganizationEntitlementDbRepository implements OrganizationEntitlementRepository {
  constructor(private readonly dbClient: OrganizationDirectoryTenantClient) {}

  getPlanTier(context: TenantContext): TE.TaskEither<"organization_not_found" | RepositoryDependencyError, PlanTier> {
    return TE.tryCatch(
      async () => {
        const organization = await this.dbClient.cx.organization.findUnique({
          where: {id: context.organizationId},
          select: {planTier: true}
        })
        if (!organization) throw new OrganizationNotFoundError()
        if (!isPlanTier(organization.planTier)) throw new InvalidPlanTierError()
        return organization.planTier
      },
      error => {
        if (error instanceof OrganizationNotFoundError) return "organization_not_found"
        if (error instanceof InvalidPlanTierError) {
          Logger.error("Organization entitlement contains an invalid plan tier")
          return "repository_dependency_error"
        }
        // The transaction boundary owns infrastructure failures and serialization retries.
        throw error
      }
    )
  }
}

class OrganizationNotFoundError extends Error {}
class InvalidPlanTierError extends Error {}
