import {Injectable, Logger, OnModuleInit, OnModuleDestroy} from "@nestjs/common"
import {PrismaClient, Prisma} from "@prisma/client"
import {ConfigProvider} from "../config"
import {transactionContext} from "./transaction-context"
import {PrismaPg} from "@prisma/adapter-pg"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {checkMigrationId} from "./migration-utils"
import {retryWithBackoff} from "@utils"

// This constant MUST be updated whenever the repositories need to access properties defined by a
// a newer migration file. The timestamp provided here is used to check if the database is using
// a migration that is older than the one required by the repositories. If this is the case, the
// application will fail to start.
export const REQUIRED_DB_MIGRATION_TIMESTAMP = "20260530120000"

const TRANSIENT_CODES = [
  "P1001", // Can't reach database server
  "P1008", // Operations timed out
  "P1017", // Server closed connection
  "P2024", // Connection pool timeout
  "P2028", // Transaction API error
  "P2034" // Transaction failed due to write conflict or deadlock
]

export class ConflictingIsolationLevelError extends Error {
  constructor(requested: string, active: string) {
    super(
      `Transaction isolation level conflict: Requested ${requested}, but an active transaction is already running at a weaker level (${active}).`
    )
    this.name = "ConflictingIsolationLevelError"
  }
}

@Injectable()
export class DatabaseClient implements OnModuleInit, OnModuleDestroy {
  public readonly prisma: PrismaClient

  // Map standard isolation levels to numeric strictness values for comparison
  private static readonly ISOLATION_STRICTNESS: Record<Prisma.TransactionIsolationLevel, number> = {
    ReadUncommitted: 1,
    ReadCommitted: 2,
    RepeatableRead: 3,
    Serializable: 4
  }

  private static readonly DEFAULT_ISOLATION_LEVEL: Prisma.TransactionIsolationLevel =
    Prisma.TransactionIsolationLevel.ReadCommitted

  private static isTransientPrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.includes(error.code)
    return false
  }

  constructor(readonly config: ConfigProvider) {
    const basePrisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: config.dbConnectionUrl
      })
    })

    // Modify the Prisma client to prevent update/delete operations on audit logs.
    // This is not expected to be the ultimate solution for protection records, but only a
    // safe mechanism for accidental data loss due to silly mistakes.
    // Also inject automated query retries on transient errors when running outside of transaction context.
    this.prisma = basePrisma.$extends({
      query: {
        $allOperations: async ({args, query}) => {
          // If we are already running inside transactional() context, do not retry individual query.
          // Let the outer transactional() retry block handle it!
          if (transactionContext.getStore() !== undefined) return query(args) as Promise<unknown>

          // Otherwise, we are outside of a transaction. Let's retry on transient errors!
          const executeWithRetry = TE.tryCatch(
            () => query(args) as Promise<unknown>,
            error => error
          )

          return pipe(
            retryWithBackoff(
              () => executeWithRetry,
              e => DatabaseClient.isTransientPrismaError(e),
              this.config.databaseRetryConfig
            ),
            TE.getOrElse(error => {
              throw error
            })
          )()
        },
        auditLog: auditLogExtension
      }
    }) as PrismaClient
  }

  async onModuleInit() {
    await this.prisma.$connect()

    const result = await this.checkDbVersion()()

    if (E.isLeft(result)) {
      Logger.error("Database version check failed", result.left)
      throw new Error(result.left)
    }
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect()
  }

  public get cx(): Prisma.TransactionClient {
    return transactionContext.getStore()?.tx ?? this.prisma
  }

  /**
   * Executes a computation within a transaction.
   *
   * If an active transaction is already present in the context, it will be reused.
   * Otherwise, a new interactive transaction will be started with the provided options.
   *
   * @param computation - A function that receives the transaction client and returns a promise.
   * @param options - Optional configuration (e.g., isolationLevel).
   */
  public transactional<T>(
    computation: (cx: Prisma.TransactionClient) => Promise<T>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    const activeContext = transactionContext.getStore()
    const isolationLevel = options?.isolationLevel ?? DatabaseClient.DEFAULT_ISOLATION_LEVEL

    // If an active transaction exists, reuse it and check isolation level
    if (activeContext) {
      const requestedStrictness = DatabaseClient.ISOLATION_STRICTNESS[isolationLevel]
      const currentStrictness = DatabaseClient.ISOLATION_STRICTNESS[activeContext.isolationLevel]

      if (requestedStrictness > currentStrictness)
        throw new ConflictingIsolationLevelError(isolationLevel, activeContext.isolationLevel)

      return computation(activeContext.tx)
    }

    // Start a new transaction and initialize context
    const doTx = TE.tryCatch(
      () =>
        this.prisma.$transaction(
          async tx => {
            return transactionContext.run({tx, isolationLevel}, () => computation(tx))
          },
          {isolationLevel}
        ),
      error => error
    )

    return pipe(
      retryWithBackoff(
        () => doTx,
        e => DatabaseClient.isTransientPrismaError(e),
        this.config.databaseRetryConfig
      ),
      // If TE.left, we exhausted retries or hit a non-transient error; throw it so Promise rejects
      TE.getOrElse(error => {
        throw error
      })
    )()
  }

  private checkDbVersion(): TE.TaskEither<string, void> {
    return pipe(
      TE.tryCatch(
        async () => {
          const result = await this.prisma.databasechangelog.findFirst({
            orderBy: {
              id: "desc"
            }
          })
          return result
        },
        reason => `Failed to query database changelog: ${String(reason)}`
      ),
      TE.chain(latestMigration => {
        if (!latestMigration) return TE.left("No migrations found in database.")

        return TE.fromEither(checkMigrationId(latestMigration.id, REQUIRED_DB_MIGRATION_TIMESTAMP))
      })
    )
  }
}

const auditLogExtension = {
  update() {
    throw new Error("Audit logs are immutable. Action update is not allowed.")
  },
  updateMany() {
    throw new Error("Audit logs are immutable. Action updateMany is not allowed.")
  },
  delete() {
    throw new Error("Audit logs are immutable. Action delete is not allowed.")
  },
  deleteMany() {
    throw new Error("Audit logs are immutable. Action deleteMany is not allowed.")
  },
  upsert() {
    throw new Error("Audit logs are immutable. Action upsert is not allowed.")
  }
}
