import {Inject, Injectable} from "@nestjs/common"
import {WorkerDatabaseClient} from "./capability-database-client"
import {PrismaTransactionManager} from "./transaction-manager"

/** Applies the shared rollback/error contract using only the worker database capability. */
@Injectable()
export class PrismaWorkerTransactionManager extends PrismaTransactionManager {
  constructor(@Inject(WorkerDatabaseClient) workers: WorkerDatabaseClient) {
    super(workers)
  }
}
