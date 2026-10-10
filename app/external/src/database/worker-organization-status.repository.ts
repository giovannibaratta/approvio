import {Injectable, Logger} from "@nestjs/common"
import {OrgStatus, TenantContext} from "@domain"
import {OrganizationStatusRepository, OrganizationStatusError} from "@services/tenancy/interfaces"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {WorkerDatabaseClient} from "./capability-database-client"

/** Uses the restricted worker capability and joins the active dispatch transaction. */
@Injectable()
export class WorkerOrganizationStatusDbRepository implements OrganizationStatusRepository {
  constructor(private readonly workers: WorkerDatabaseClient) {}

  getStatus(context: TenantContext): TE.TaskEither<OrganizationStatusError, OrgStatus> {
    return pipe(
      TE.tryCatch(
        () => this.workers.transactional(context.organizationId, cx => cx.getOrganizationStatus()),
        error => {
          Logger.error("Worker organization status read failed", error)
          return "repository_dependency_error" as const
        }
      ),
      TE.chainW(status => {
        if (status === null) return TE.left("organization_not_found" as const)
        if (status === "active" || status === "suspended" || status === "deleting" || status === "deleted")
          return TE.right(status)
        return TE.left("repository_dependency_error" as const)
      })
    )
  }
}
