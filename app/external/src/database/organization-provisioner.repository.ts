import {fromEitherPromise} from "./repository-operation"
import {Injectable} from "@nestjs/common"
import {
  Organization,
  OrganizationSummary,
  OrganizationSummaryFactory,
  OrganizationSummaryValidationError,
  PlanTier
} from "@domain"
import {OrganizationProvisioner, RepositoryDependencyError} from "@services"
import * as TE from "fp-ts/TaskEither"
import {OrganizationProvisionerTenantClient} from "./tenant-database-clients"
import {isPrismaUniqueConstraintError} from "./errors"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class OrganizationProvisionerDbRepository implements OrganizationProvisioner {
  constructor(private readonly dbClient: OrganizationProvisionerTenantClient) {}

  createOrganization(
    organization: Organization,
    planTier: PlanTier
  ): TE.TaskEither<
    "resource_already_exists" | OrganizationSummaryValidationError | RepositoryDependencyError,
    OrganizationSummary
  > {
    return fromEitherPromise(
      async () => {
        const persisted = await this.dbClient.cx.organization.create({
          data: {
            id: organization.id,
            slug: organization.slug,
            displayName: organization.displayName,
            planTier,
            status: organization.status,
            suspensionReason: organization.status === "suspended" ? organization.suspensionReason : null,
            graceUntil: organization.status === "suspended" ? organization.graceUntil : null,
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt,
            occ: POSTGRES_BIGINT_LOWER_BOUND,
            workflowExpirationSchedules: {create: {occ: POSTGRES_BIGINT_LOWER_BOUND}}
          },
          select: {id: true, slug: true, displayName: true, status: true, occ: true}
        })
        return OrganizationSummaryFactory.validate(persisted)
      },
      error => {
        if (
          isPrismaUniqueConstraintError(error, ["id"], "organizations_pkey") ||
          isPrismaUniqueConstraintError(error, ["slug"], "organizations_slug_unique")
        )
          return "resource_already_exists"
        return "repository_dependency_error" as const
      }
    )
  }
}
