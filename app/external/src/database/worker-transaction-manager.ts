import {Inject, Injectable} from "@nestjs/common"
import {WorkerDatabaseClient} from "./capability-database-client"
import {PrismaTransactionManager} from "./transaction-manager"
import {TenantContextRequiredError} from "./database-client"

/** Applies the shared rollback/error contract using only the worker database capability. */
@Injectable()
export class PrismaWorkerTransactionManager extends PrismaTransactionManager {
  constructor(@Inject(WorkerDatabaseClient) workers: WorkerDatabaseClient) {
    super({
      transactional: (scope, computation, options) => {
        if (scope.type !== "organization") throw new TenantContextRequiredError()
        return workers.transactional(scope.organizationId, computation, options)
      }
    })
  }
}
