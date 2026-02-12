import {Injectable, Logger, OnModuleInit, OnModuleDestroy} from "@nestjs/common"
import {PrismaClient} from "@prisma/client"
import {ConfigProvider} from "../config"
import {PrismaPg} from "@prisma/adapter-pg"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"

// This constant MUST be updated whenever the repositories need to access properties defined by a
// a newer migration file. The timestamp provided here is used to check if the database is using
// a migration that is older than the one required by the repositories. If this is the case, the
// application will fail to start.
export const REQUIRED_DB_MIGRATION_TIMESTAMP = "20260208132808"

@Injectable()
export class DatabaseClient extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(readonly config: ConfigProvider) {
    super({
      adapter: new PrismaPg({
        connectionString: config.dbConnectionUrl
      })
    })
  }

  async onModuleInit() {
    await this.$connect()

    const result = await this.checkDbVersion()()

    if (E.isLeft(result)) {
      Logger.error("Database version check failed", result.left.message)
      throw result.left
    }
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }

  private checkDbVersion(): TE.TaskEither<Error, void> {
    return pipe(
      TE.tryCatch(
        async () => {
          const result = await this.databasechangelog.findFirst({
            orderBy: {
              id: "desc"
            }
          })
          return result
        },
        reason => new Error(`Failed to query database changelog: ${String(reason)}`)
      ),
      TE.chain(latestMigration => {
        if (!latestMigration) return TE.left(new Error("No migrations found in database."))

        // The ID should have the following format YYYYMMDDHHMMSS-<arbitrary-string>
        const timestamp = latestMigration.id.split("-")[0]

        if (timestamp === undefined || timestamp.length !== 14)
          return TE.left(new Error(`Invalid migration ID format. Found ${latestMigration.id}.`))

        // Convert timestamp and REQUIRED_DB_MIGRATION_TIMESTAMP to Date objects for comparison
        const timestampDate = new Date(timestamp)
        const requiredTimestampDate = new Date(REQUIRED_DB_MIGRATION_TIMESTAMP)

        if (timestampDate < requiredTimestampDate) {
          return TE.left(
            new Error(
              `Database version mismatch. Required minimum: ${REQUIRED_DB_MIGRATION_TIMESTAMP}, Found latest: ${latestMigration.id}. Please update your database.`
            )
          )
        }

        return TE.right(undefined)
      })
    )
  }
}
