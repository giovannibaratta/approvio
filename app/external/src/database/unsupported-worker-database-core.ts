import {DatabaseClient} from "./database-client"

/** API composition supplies no worker pool. Reject before executing worker callbacks. */
export class UnsupportedWorkerDatabaseCore implements Pick<DatabaseClient, "transactional"> {
  transactional<T>(): Promise<T> {
    return Promise.reject(new WorkerDatabaseUnsupportedError())
  }
}

export class WorkerDatabaseUnsupportedError extends Error {
  constructor() {
    super("Worker database operations are not supported in API composition")
    this.name = "WorkerDatabaseUnsupportedError"
  }
}
