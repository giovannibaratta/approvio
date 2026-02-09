import {Injectable, Logger} from "@nestjs/common"
import {DatabaseClient} from "./database-client"
import {DbHealthCheckFailed, HealthRepository} from "@services/health/health.repository"
import * as TE from "fp-ts/TaskEither"

@Injectable()
export class PrismaHealthRepository implements HealthRepository {
  constructor(private readonly prisma: DatabaseClient) {}

  checkDatabaseConnection(): TE.TaskEither<DbHealthCheckFailed, void> {
    return TE.tryCatch(
      async () => {
        await this.prisma.$queryRaw`SELECT 1`
      },
      error => {
        Logger.error("Failed to check database connection")
        Logger.error(error)
        return "db_health_check_failed"
      }
    )
  }
}
