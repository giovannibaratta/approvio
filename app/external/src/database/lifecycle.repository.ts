import {fromPromise, fromEitherPromise} from "./repository-operation"
import {chainNullableToLeft} from "./utils"
import {pipe} from "fp-ts/function"
import {Injectable} from "@nestjs/common"
import {LifecycleRepository, OrganizationSummary} from "@services"
import {
  MutationError,
  OrganizationSummaryFactory,
  OrganizationFactory,
  OrganizationValidationError,
  OrganizationSummaryValidationError,
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
  ): TE.TaskEither<
    MutationError | OrganizationSummaryValidationError | "repository_dependency_error",
    OrganizationSummary
  > {
    return pipe(
      fromPromise(
        () => this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}}),
        error => this.mapError(error)
      ),
      chainNullableToLeft("organization_not_found" as const),
      TE.chainEitherKW(mapOrganization)
    )
  }

  update(
    context: TenantContext,
    expectedVersion: bigint,
    organization: OrganizationSummary,
    updatedAt: Date
  ): TE.TaskEither<
    MutationError | OrganizationSummaryValidationError | "repository_dependency_error",
    OrganizationSummary
  > {
    return fromEitherPromise(
      async () => {
        const updated = await this.dbClient.cx.organization.update({
          where: {id: context.organizationId, occ: expectedVersion},
          data: {
            slug: organization.slug,
            displayName: organization.displayName,
            status: organization.status,
            updatedAt,
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
    return pipe(
      fromPromise(
        () => this.dbClient.cx.organization.findUnique({where: {id: context.organizationId}}),
        error => this.mapError(error)
      ),
      chainNullableToLeft("organization_not_found" as const),
      TE.chainEitherKW(row =>
        E.map((organization: Organization) => ({...organization, occ: row.occ}))(
          OrganizationFactory.validate({...row, organizationId: row.id, graceUntil: row.graceUntil ?? undefined})
        )
      )
    )
  }

  persistTransition(
    context: TenantContext,
    expectedVersion: bigint,
    organization: Organization
  ): TE.TaskEither<
    MutationError | OrganizationSummaryValidationError | "repository_dependency_error",
    OrganizationSummary
  > {
    return fromEitherPromise(
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
    if (isPrismaRecordNotFoundError(error, "Organization")) return "concurrent_modification_error"
    // The transaction boundary owns infrastructure failures and serialization retries.
    return "repository_dependency_error"
  }
}

function mapOrganization(row: OrganizationRow): E.Either<OrganizationSummaryValidationError, OrganizationSummary> {
  return OrganizationSummaryFactory.validate({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    status: row.status,
    occ: row.occ
  })
}
