import {Injectable} from "@nestjs/common"
import {LifecycleRepository, OrganizationSummary} from "@services"
import {
  MutationError,
  OrganizationSummaryFactory,
  OrganizationFactory,
  OrganizationValidationError,
  Versioned,
  TenantContext
} from "@domain"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {LifecycleTenantClient} from "./tenant-database-clients"
import {Organization as OrganizationRow} from "@prisma/client"
import {Organization} from "@domain"
import {isPrismaRecordNotFoundError} from "./errors"

@Injectable()
export class LifecycleDbRepository implements LifecycleRepository {
  constructor(private readonly dbClient: LifecycleTenantClient) {}

  getSummary(
    context: TenantContext
  ): TE.TaskEither<MutationError | "repository_dependency_error", OrganizationSummary> {
    return TE.tryCatch(
      async () => {
        const organization = await this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}})
        if (!organization) throw new OrganizationNotFoundError()
        return mapOrganization(organization)
      },
      error => this.mapError(error)
    )
  }

  update(
    context: TenantContext,
    expectedVersion: bigint,
    organization: OrganizationSummary
  ): TE.TaskEither<MutationError | "repository_dependency_error", OrganizationSummary> {
    return TE.tryCatch(
      async () => {
        const updated = await this.dbClient.cx.organization.update({
          // TODO: status filtering should not be driven by the repo
          where: {id: context.organizationId, occ: expectedVersion, status: {in: ["active", "suspended"]}},
          data: {
            slug: organization.slug,
            displayName: organization.displayName,
            status: organization.status,
            // TODO: this should not be driven by the repo. domain/service is responsible for it.
            updatedAt: new Date(),
            occ: {increment: 1}
          }
        })
        return mapOrganization(updated)
      },
      error => this.mapError(error)
    )
  }

  get(
    context: TenantContext
  ): TE.TaskEither<
    MutationError | "repository_dependency_error" | OrganizationValidationError,
    Versioned<Organization>
  > {
    // TODO: I am bit confused by this code . the order seems wrong even if correct. I don't like it.
    return TE.chainEitherKW((row: OrganizationRow) =>
      E.map((organization: Organization) => ({...organization, occ: row.occ}))(
        OrganizationFactory.validate({...row, organizationId: row.id, graceUntil: row.graceUntil ?? undefined})
      )
    )(
      TE.tryCatch(
        async () => {
          const row = await this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}})
          if (!row) throw new OrganizationNotFoundError()
          return row
        },
        error => this.mapError(error)
      )
    )
  }

  persistTransition(
    context: TenantContext,
    expectedVersion: bigint,
    organization: Organization
  ): TE.TaskEither<MutationError | "repository_dependency_error", OrganizationSummary> {
    return TE.tryCatch(
      async () => {
        const updated = await this.dbClient.cx.organization.update({
          where: {id: context.organizationId, AND: {id: organization.id}, occ: expectedVersion},
          data: {
            status: organization.status,
            suspensionReason: organization.status === "suspended" ? organization.suspensionReason : null,
            graceUntil: organization.status === "suspended" ? (organization.graceUntil ?? null) : null,
            updatedAt: organization.updatedAt,
            occ: {increment: 1}
          }
        })
        return mapOrganization(updated)
      },
      error => this.mapError(error)
    )
  }

  private mapError(error: unknown): MutationError | "repository_dependency_error" {
    if (error instanceof OrganizationNotFoundError) return "organization_not_found"
    if (isPrismaRecordNotFoundError(error, "Organization")) return "concurrent_modification_error"
    // The transaction boundary owns infrastructure failures and serialization retries.
    // TODO: This throw will escpate the fp-ts try catch. All the calls must end with a left or right.
    throw error
  }
}

function mapOrganization(row: OrganizationRow): OrganizationSummary {
  if (row.status !== "active" && row.status !== "suspended" && row.status !== "deleting" && row.status !== "deleted")
    throw new Error("Invalid organization status")
  const summary = OrganizationSummaryFactory.validate({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    status: row.status,
    occ: row.occ
  })
  // TODO: We should not mask the error. we should return the left and use fp-ts pipe in the caller.
  if (E.isLeft(summary)) throw new Error("Invalid organization summary returned by persistence")
  return summary.right
}

class OrganizationNotFoundError extends Error {}
