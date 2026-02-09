import {TaskEither} from "fp-ts/TaskEither"

export const HEALTH_REPOSITORY_TOKEN = Symbol("HEALTH_REPOSITORY_TOKEN")

export type DbHealthCheckFailed = "db_health_check_failed"

export interface HealthRepository {
  checkDatabaseConnection(): TaskEither<DbHealthCheckFailed, void>
}
