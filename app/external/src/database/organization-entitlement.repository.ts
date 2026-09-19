import {pipe} from "fp-ts/function"
import {fromPromise} from "./repository-operation"
import {isPlanTier, PlanTier, TenantContext} from "@domain"
import {OrganizationEntitlementRepository, RepositoryDependencyError} from "@services"
import {Injectable} from "@nestjs/common"
import * as TE from "fp-ts/TaskEither"
import {OrganizationDirectoryTenantClient} from "./tenant-database-clients"
import {chainNullableToLeft} from "./utils"

@Injectable()
export class OrganizationEntitlementDbRepository implements OrganizationEntitlementRepository {
  constructor(private readonly dbClient: OrganizationDirectoryTenantClient) {}

  getPlanTier(context: TenantContext): TE.TaskEither<"organization_not_found" | RepositoryDependencyError, PlanTier> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.organization.findUnique({
            where: {id: context.organizationId},
            select: {planTier: true}
          }),
        () => "repository_dependency_error" as const
      ),
      chainNullableToLeft("organization_not_found" as const),
      TE.map(({planTier}) => planTier),
      TE.filterOrElseW(isPlanTier, () => "repository_dependency_error" as const)
    )
  }
}
