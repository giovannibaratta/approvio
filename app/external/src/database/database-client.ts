import {Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy} from "@nestjs/common"
import {PrismaClient, Prisma} from "@prisma/client"
import {ConfigProvider} from "../config"
import {DatabaseRuntimeRole, DatabaseScope, transactionContext} from "./transaction-context"
import {isIsolationLevelSufficient} from "./transaction-isolation"
import {PrismaPg} from "@prisma/adapter-pg"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {checkMigrationId} from "./migration-utils"
import {isUUIDv7} from "@utils"
import {isRetryableTransactionError, unwrapTransactionResult, trackTransactionResult} from "./repository-operation"

// This constant MUST be updated whenever the repositories need to access properties defined by a
// a newer migration file. The timestamp provided here is used to check if the database is using
// a migration that is older than the one required by the repositories. If this is the case, the
// application will fail to start.
export const REQUIRED_DB_MIGRATION_TIMESTAMP = "20260926120000"

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

export class GlobalScopeRequiredError extends Error {
  constructor(runtimeRole: DatabaseRuntimeRole) {
    super(`Database capability ${runtimeRole} requires global scope`)
    this.name = "GlobalScopeRequiredError"
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

export class TransactionRetryExhaustedError extends Error {
  constructor(readonly cause: unknown) {
    super("Retryable transaction attempts were exhausted")
    this.name = "TransactionRetryExhaustedError"
  }
}

export const DATABASE_RUNTIME_ROLE_TOKEN = Symbol("DATABASE_RUNTIME_ROLE_TOKEN")

/** Shared transaction engine for a fixed capability role and connection family. */
@Injectable()
export class DatabaseClient implements OnModuleInit, OnModuleDestroy {
  private readonly prisma: PrismaClient
  private readonly requiredScope: DatabaseScope["type"]

  private static readonly DEFAULT_ISOLATION_LEVEL: Prisma.TransactionIsolationLevel =
    Prisma.TransactionIsolationLevel.ReadCommitted

  constructor(
    @Inject(ConfigProvider) readonly config: Pick<ConfigProvider, "databaseConfig">,
    @Inject(DATABASE_RUNTIME_ROLE_TOKEN)
    readonly runtimeRole: DatabaseRuntimeRole
  ) {
    const organizationScoped = runtimeRole === "approvio_tenant_runtime" || runtimeRole === "approvio_worker_runtime"
    this.requiredScope = organizationScoped ? "organization" : "global"
    const connectionString =
      organizationScoped || runtimeRole === "approvio_scheduler_runtime"
        ? config.databaseConfig.tenantConnectionUrl
        : config.databaseConfig.platformConnectionUrl
    const basePrisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        max: config.databaseConfig.poolSize
      })
    })

    // Prevent audit-log mutations and restrict receipt updates to atomic consumption.
    // This is not expected to be the ultimate solution for protection records, but only a
    // safe mechanism for accidental data loss due to silly mistakes.

    this.prisma = basePrisma
      .$extends({
        query: {
          auditLog: auditLogExtension
        }
      })
      .$extends(stepUpReceiptExtension) as PrismaClient
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

  checkConnection(): Promise<void> {
    return this.prisma.$queryRaw`SELECT 1`.then(() => undefined)
  }

  /**
   * Executes a computation within a transaction.
   *
   * Reuses an active transaction owned by this client when scope and isolation
   * are compatible. Other clients open independent transactions. Confirmed
   * conflicts retry the whole callback, so the computation must contain DB work only.
   *
   * @param scope - Explicit global/organization scope.
   * The configured runtime role determines which scope this client accepts.
   * @param computation - A function that receives the transaction client and returns a promise.
   * @param options - Optional configuration (e.g., isolationLevel).
   */
  public transactional<T>(
    scope: DatabaseScope,
    computation: (cx: Prisma.TransactionClient) => Promise<T>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    const requestedScope = {...scope}

    if (requestedScope.type !== this.requiredScope) {
      if (this.requiredScope === "organization") throw new TenantContextRequiredError()
      throw new GlobalScopeRequiredError(this.runtimeRole)
    }

    if (requestedScope.type === "organization" && !isUUIDv7(requestedScope.organizationId))
      throw new InvalidOrganizationIdError()

    const activeContext = transactionContext.getStore()
    const isolationLevel = options?.isolationLevel ?? DatabaseClient.DEFAULT_ISOLATION_LEVEL

    // If an active transaction exists, reuse it and check isolation level
    if (
      activeContext?.scope.type === "organization" &&
      requestedScope.type === "organization" &&
      activeContext.scope.organizationId !== requestedScope.organizationId
    )
      throw new OrganizationMismatchError(requestedScope.organizationId, activeContext.scope.organizationId)

    // Different process capabilities must not borrow each other's transaction privileges.
    if (activeContext?.client === this) {
      this.assertTransactionIsolationLevel(isolationLevel)
      return computation(activeContext.tx)
    }

    return this.executeWithRetry(requestedScope, computation, isolationLevel)
  }

  /** Require an active transaction owned by this client with at least the requested isolation. */
  assertTransactionIsolationLevel(required: Prisma.TransactionIsolationLevel): void {
    const active = transactionContext.getStore()
    if (!active || active.client !== this) throw new TenantContextRequiredError()
    if (!isIsolationLevelSufficient(active.isolationLevel, required))
      throw new ConflictingIsolationLevelError(required, active.isolationLevel)
  }

  private async executeWithRetry<T>(
    scope: DatabaseScope,
    computation: (cx: Prisma.TransactionClient) => Promise<T>,
    isolationLevel: Prisma.TransactionIsolationLevel
  ): Promise<T> {
    const retry = this.config.databaseConfig.retry

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++)
      try {
        return await unwrapTransactionResult(() =>
          this.prisma.$transaction(
            async tx => {
              // SET LOCAL clears the runtime role at transaction end.
              await tx.$executeRawUnsafe(`SET LOCAL ROLE "${this.runtimeRole}"`)
              if (scope.type === "organization")
                await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${scope.organizationId}, true)`
              return transactionContext.run(
                {tx, scope, client: this, isolationLevel, runtimeRole: this.runtimeRole},
                () => trackTransactionResult(() => computation(tx))
              )
            },
            {isolationLevel}
          )
        )
      } catch (error) {
        if (!isRetryableTransactionError(error)) throw error
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

  private checkDbVersion(): TE.TaskEither<string, void> {
    return pipe(
      TE.tryCatch(
        () =>
          // findFirst also selects the composite key (author/filename), even with
          // select: {id: true}. Aggregation reads only the permitted identifier.
          this.prisma.databasechangelog.aggregate({_max: {id: true}}),
        reason => `Failed to query database changelog: ${String(reason)}`
      ),
      TE.chain(latestMigration => {
        const latestId = latestMigration._max.id
        if (latestId === null) return TE.left("No migrations found in database.")

        return TE.fromEither(checkMigrationId(latestId, REQUIRED_DB_MIGRATION_TIMESTAMP))
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

const stepUpReceiptExtension = Prisma.defineExtension({
  query: {
    stepUpReceipt: {
      update({args, query}) {
        if (
          Object.keys(args.data).length !== 1 ||
          !(args.data.consumedAt instanceof Date) ||
          !Number.isFinite(args.data.consumedAt.getTime()) ||
          args.where.consumedAt !== null
        )
          return rejectStepUpReceiptMutation()
        return query(args)
      },
      updateMany: rejectStepUpReceiptMutation,
      updateManyAndReturn: rejectStepUpReceiptMutation,
      upsert: rejectStepUpReceiptMutation,
      delete: rejectStepUpReceiptMutation,
      deleteMany: rejectStepUpReceiptMutation
    }
  }
})

function rejectStepUpReceiptMutation(): never {
  throw new Error("Step-up receipts only allow atomic consumption.")
}
