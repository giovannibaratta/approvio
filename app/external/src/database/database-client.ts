import {Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy} from "@nestjs/common"
import {PrismaClient, Prisma} from "@prisma/client"
import {ConfigProvider} from "../config"
import {transactionContext} from "./transaction-context"
import {PrismaPg} from "@prisma/adapter-pg"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {checkMigrationId} from "./migration-utils"
import {isUUIDv7} from "@utils"

// This constant MUST be updated whenever the repositories need to access properties defined by a
// a newer migration file. The timestamp provided here is used to check if the database is using
// a migration that is older than the one required by the repositories. If this is the case, the
// application will fail to start.
export const REQUIRED_DB_MIGRATION_TIMESTAMP = "20260912192200"

export class ConflictingIsolationLevelError extends Error {
  constructor(requested: string, active: string) {
    super(
      `Transaction isolation level conflict: Requested ${requested}, but an active transaction is already running at a weaker level (${active}).`
    )
    this.name = "ConflictingIsolationLevelError"
  }
}

export class TenantContextRequiredError extends Error {
  constructor() {
    super("A tenant transaction context is required")
    this.name = "TenantContextRequiredError"
  }
}

export class InvalidOrganizationIdError extends Error {
  constructor() {
    super("The tenant organization ID must be a UUIDv7")
    this.name = "InvalidOrganizationIdError"
  }
}

export class OrganizationMismatchError extends Error {
  constructor(requested: string, active: string) {
    super(`Tenant context mismatch: requested ${requested}, active ${active}`)
    this.name = "OrganizationMismatchError"
  }
}

// TODO: This class has been introduced replacing TRANSIENT_CODES but I don't believe we have
// covered the codes that were detected before. What is the reason for this choice ?

/**
 * Marks an operation as safe to rerun because its database transaction rolled
 * back. Database-specific retryable errors are intentionally recognized next
 * to the transaction boundary; callers use this marker for domain conflicts
 * with the same rollback guarantee.
 */
export class RetryableTransactionError extends Error {
  constructor(message = "The transaction must be retried") {
    super(message)
    this.name = "RetryableTransactionError"
  }
}

export class TransactionRetryExhaustedError extends Error {
  constructor(readonly cause: unknown) {
    super("Retryable transaction attempts were exhausted")
    this.name = "TransactionRetryExhaustedError"
  }
}

interface TenantDatabaseConfig extends Pick<ConfigProvider, "dbConnectionUrl" | "databaseRetryConfig"> {
  // TODO: Should we include this in the a database config or parma in the Config provider and maybe push everything under a databse field ?
  readonly databasePoolSize?: number
}

const TENANT_RUNTIME_ROLE = "approvio_tenant_runtime"

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

  constructor(@Inject(ConfigProvider) readonly config: TenantDatabaseConfig) {
    const basePrisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: config.dbConnectionUrl,
        max: config.databasePoolSize
      })
    })

    // Modify the Prisma client to prevent update/delete operations on audit logs.
    // This is not expected to be the ultimate solution for protection records, but only a
    // safe mechanism for accidental data loss due to silly mistakes.

    // TODO: Should we block any non transactional (that enforce the org context) ?  keep in mind the platform operator access. Maybe it is safer to have two diffent clients.
    // TODO: The expanation does not make much sense to me. If we are not doing only for testing I would like to see
    // a proper implementation.

    // Tenant repositories use cx/transactional. This base client is retained
    // as a public test seam for now; production platform access uses
    // capability-specific clients. Removing that seam requires migrating the
    // existing integration fixtures to a test-only database helper.
    this.prisma = basePrisma.$extends({
      query: {
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
    const activeContext = transactionContext.getStore()
    if (!activeContext) throw new TenantContextRequiredError()
    return activeContext.tx
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
    organizationId: string,
    computation: (cx: Prisma.TransactionClient) => Promise<T>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    if (!isUUIDv7(organizationId)) throw new InvalidOrganizationIdError()

    const activeContext = transactionContext.getStore()
    const isolationLevel = options?.isolationLevel ?? DatabaseClient.DEFAULT_ISOLATION_LEVEL

    // If an active transaction exists, reuse it and check isolation level
    if (activeContext) {
      if (activeContext.organizationId !== organizationId)
        throw new OrganizationMismatchError(organizationId, activeContext.organizationId)

      const requestedStrictness = DatabaseClient.ISOLATION_STRICTNESS[isolationLevel]
      const currentStrictness = DatabaseClient.ISOLATION_STRICTNESS[activeContext.isolationLevel]

      if (requestedStrictness > currentStrictness)
        throw new ConflictingIsolationLevelError(isolationLevel, activeContext.isolationLevel)

      return computation(activeContext.tx)
    }

    return this.executeWithRetry(organizationId, computation, isolationLevel)
  }

  private async executeWithRetry<T>(
    organizationId: string,
    computation: (cx: Prisma.TransactionClient) => Promise<T>,
    isolationLevel: Prisma.TransactionIsolationLevel
  ): Promise<T> {
    const retry = this.config.databaseRetryConfig

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++)
      try {
        return await this.prisma.$transaction(
          async tx => {
            // SET LOCAL clears the runtime role at transaction end. The role
            // activates tenant RLS; the setting supplies its only accepted
            // organization identifier and also clears at transaction end.
            await tx.$executeRawUnsafe(`SET LOCAL ROLE "${TENANT_RUNTIME_ROLE}"`)
            await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${organizationId}, true)`
            return transactionContext.run({tx, organizationId, isolationLevel}, () => computation(tx))
          },
          {isolationLevel}
        )
      } catch (error) {
        if (!DatabaseClient.isRetryableTransactionError(error)) throw error
        if (attempt === retry.maxAttempts) throw new TransactionRetryExhaustedError(error)

        const maximumDelay = Math.min(
          retry.initialDelayMs * Math.pow(retry.backoffFactor, attempt - 1),
          retry.maxDelayMs
        )
        const jitteredDelay = Math.floor(Math.random() * (maximumDelay + 1))
        // Full jitter prevents synchronized retries after a shared database conflict.
        if (jitteredDelay > 0) await new Promise(resolve => setTimeout(resolve, jitteredDelay))
      }

    throw new TransactionRetryExhaustedError(new Error("Retry loop exhausted without a captured database error"))
  }

  private static isRetryableTransactionError(error: unknown): boolean {
    if (error instanceof RetryableTransactionError) return true
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
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
