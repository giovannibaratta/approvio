import {fromPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {OrgStatus, TenantContext, isOrgStatus} from "@domain"
import {OrganizationStatusRepository, OrganizationStatusError} from "@services/tenancy/interfaces"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {WorkerDatabaseClient} from "./capability-database-client"
import {chainNullableToLeft} from "./utils"

/** Uses the restricted worker capability and joins the active dispatch transaction. */
@Injectable()
export class WorkerOrganizationStatusDbRepository implements OrganizationStatusRepository {
  constructor(private readonly workers: WorkerDatabaseClient) {}

  getStatus(context: TenantContext): TE.TaskEither<OrganizationStatusError, OrgStatus> {
    return pipe(
      fromPromise(
        () =>
          this.workers.transactional(context.organizationId, cx =>
            cx.organization.findUnique({where: {id: context.organizationId}, select: {status: true}})
          ),
        error => {
          Logger.error("Worker organization status read failed", error)
          return "repository_dependency_error" as const
        }
      ),
      chainNullableToLeft("organization_not_found" as const),
      TE.chainEitherKW(({status}) => E.fromPredicate(isOrgStatus, () => "repository_dependency_error" as const)(status))
    )
  }
}
