import {Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional} from "@nestjs/common"
import {AsyncLocalStorage} from "node:async_hooks"
import {Prisma, PrismaClient} from "@prisma/client"
import {PrismaPg} from "@prisma/adapter-pg"
import {isUUIDv7} from "@utils"
import {ConfigProvider} from "../config"
import {
  ConflictingIsolationLevelError,
  DatabaseClient,
  InvalidOrganizationIdError,
  OrganizationMismatchError,
  TransactionRetryExhaustedError
} from "./database-client"
import {EventReceiptConsumer, EventReceiptResult, recordTenantEventReceipt} from "./event-receipt-operation"

type PlatformCapabilityRole =
  | "approvio_identity_runtime"
  | "approvio_session_runtime"
  | "approvio_discovery_runtime"
  | "approvio_scheduler_runtime"
  | "approvio_worker_runtime"
  | "approvio_security_runtime"

type PlatformDatabaseConfig = Pick<ConfigProvider, "databaseConfig">
type SchedulerDatabaseConfig = Pick<ConfigProvider, "databaseConfig">
type WorkerDatabaseConfig = Pick<ConfigProvider, "databaseConfig">
const ISOLATION_LEVELS: ReadonlyArray<Prisma.TransactionIsolationLevel> = [
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable"
]

type IdentityTransaction = Pick<Prisma.TransactionClient, "platformAccount" | "platformAccountIdentity">
type SessionTransaction = Pick<Prisma.TransactionClient, "browserSession" | "refreshToken" | "pkceSession">
type DiscoveryTransaction = Pick<Prisma.TransactionClient, "user">
type SchedulerTransaction = Pick<Prisma.TransactionClient, "organization">
export type WorkerTransaction = Pick<
  Prisma.TransactionClient,
  | "durableWork"
  | "workflowActionsEmailTask"
  | "workflowActionsWebhookTask"
  | "workflowActionsSlackTask"
  | "tenantOutbox"
  | "dispatchAttempt"
> & {
  readonly getOrganizationStatus: () => Promise<string | null>
  readonly eventReceipts: {
    record(consumer: EventReceiptConsumer, eventId: string): Promise<EventReceiptResult>
  }
}
type SecurityTransaction = Pick<Prisma.TransactionClient, "platformSecurityEvent">

function identityTransaction(tx: Prisma.TransactionClient): IdentityTransaction {
  return {
    platformAccount: tx.platformAccount,
    platformAccountIdentity: tx.platformAccountIdentity
  }
}

function sessionTransaction(tx: Prisma.TransactionClient): SessionTransaction {
  return {browserSession: tx.browserSession, refreshToken: tx.refreshToken, pkceSession: tx.pkceSession}
}

function discoveryTransaction(tx: Prisma.TransactionClient): DiscoveryTransaction {
  return {user: tx.user}
}

function schedulerTransaction(tx: Prisma.TransactionClient): SchedulerTransaction {
  return {organization: tx.organization}
}

function workerTransaction(tx: Prisma.TransactionClient, activeOrganizationId?: string): WorkerTransaction {
  if (!activeOrganizationId) throw new InvalidOrganizationIdError()
  return {
    durableWork: tx.durableWork,
    workflowActionsEmailTask: tx.workflowActionsEmailTask,
    workflowActionsWebhookTask: tx.workflowActionsWebhookTask,
    workflowActionsSlackTask: tx.workflowActionsSlackTask,
    tenantOutbox: tx.tenantOutbox,
    dispatchAttempt: tx.dispatchAttempt,
    getOrganizationStatus: async () => {
      const organization = await tx.organization.findUnique({
        where: {id: activeOrganizationId},
        select: {status: true}
      })
      return organization?.status ?? null
    },
    eventReceipts: {
      record: (consumer, eventId) => recordTenantEventReceipt(tx, activeOrganizationId, consumer, eventId)
    }
  }
}

function securityTransaction(tx: Prisma.TransactionClient): SecurityTransaction {
  return {platformSecurityEvent: tx.platformSecurityEvent}
}

class RestrictedCapabilityConnection<TTransaction> implements OnModuleInit, OnModuleDestroy {
  private readonly prisma: PrismaClient

  constructor(
    connectionString: string,
    private readonly role: PlatformCapabilityRole,
    private readonly createTransaction: (tx: Prisma.TransactionClient, organizationId?: string) => TTransaction
  ) {
    this.prisma = new PrismaClient({adapter: new PrismaPg({connectionString})})
  }

  onModuleInit(): Promise<void> {
    return this.prisma.$connect()
  }

  onModuleDestroy(): Promise<void> {
    return this.prisma.$disconnect()
  }

  transactional<T>(
    computation: (cx: TTransaction) => Promise<T>,
    organizationId?: string,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    if (organizationId !== undefined && !isUUIDv7(organizationId)) throw new InvalidOrganizationIdError()

    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${this.role}"`)
      if (organizationId !== undefined)
        await tx.$queryRaw`SELECT set_config('approvio.organization_id', ${organizationId}, true)`
      return computation(this.createTransaction(tx, organizationId))
    }, options)
  }
}

abstract class PlatformCapabilityDatabaseClient<TTransaction> implements OnModuleInit, OnModuleDestroy {
  protected readonly connection: RestrictedCapabilityConnection<TTransaction>

  protected constructor(
    config: PlatformDatabaseConfig,
    role: PlatformCapabilityRole,
    createTransaction: (tx: Prisma.TransactionClient) => TTransaction
  ) {
    this.connection = new RestrictedCapabilityConnection(
      config.databaseConfig.platformConnectionUrl,
      role,
      createTransaction
    )
  }

  onModuleInit(): Promise<void> {
    return this.connection.onModuleInit()
  }

  onModuleDestroy(): Promise<void> {
    return this.connection.onModuleDestroy()
  }

  transactional<T>(computation: (cx: TTransaction) => Promise<T>): Promise<T> {
    return this.connection.transactional(computation)
  }
}

@Injectable()
export class IdentityDatabaseClient extends PlatformCapabilityDatabaseClient<IdentityTransaction> {
  constructor(@Inject(ConfigProvider) config: PlatformDatabaseConfig) {
    super(config, "approvio_identity_runtime", identityTransaction)
  }
}

@Injectable()
export class SessionDatabaseClient extends PlatformCapabilityDatabaseClient<SessionTransaction> {
  constructor(@Inject(ConfigProvider) config: PlatformDatabaseConfig) {
    super(config, "approvio_session_runtime", sessionTransaction)
  }
}

@Injectable()
export class DiscoveryDatabaseClient extends PlatformCapabilityDatabaseClient<DiscoveryTransaction> {
  constructor(@Inject(ConfigProvider) config: PlatformDatabaseConfig) {
    super(config, "approvio_discovery_runtime", discoveryTransaction)
  }
}

@Injectable()
export class SchedulerDatabaseClient implements OnModuleInit, OnModuleDestroy {
  private readonly connection: RestrictedCapabilityConnection<SchedulerTransaction>

  constructor(@Inject(ConfigProvider) config: SchedulerDatabaseConfig) {
    this.connection = new RestrictedCapabilityConnection(
      config.databaseConfig.tenantConnectionUrl,
      "approvio_scheduler_runtime",
      schedulerTransaction
    )
  }

  onModuleInit(): Promise<void> {
    return this.connection.onModuleInit()
  }

  onModuleDestroy(): Promise<void> {
    return this.connection.onModuleDestroy()
  }

  transactional<T>(computation: (cx: SchedulerTransaction) => Promise<T>): Promise<T> {
    return this.connection.transactional(computation)
  }
}

/**
 * Tenant-scoped worker capability. Unlike request processing, task dispatch may
 * mutate only the durable work tables granted to `approvio_worker_runtime`.
 */
@Injectable()
export class WorkerDatabaseClient implements OnModuleInit, OnModuleDestroy {
  private readonly connection: RestrictedCapabilityConnection<WorkerTransaction>
  private readonly context = new AsyncLocalStorage<{
    readonly organizationId: string
    readonly cx: WorkerTransaction
    readonly isolationLevel: Prisma.TransactionIsolationLevel
  }>()

  private readonly retry: WorkerDatabaseConfig["databaseConfig"]["retry"]

  constructor(
    @Inject(ConfigProvider) config: WorkerDatabaseConfig,
    @Optional() @Inject(DatabaseClient) private readonly database?: DatabaseClient
  ) {
    this.retry = config.databaseConfig.retry
    this.connection = new RestrictedCapabilityConnection(
      config.databaseConfig.tenantConnectionUrl,
      "approvio_worker_runtime",
      workerTransaction
    )
  }

  onModuleInit(): Promise<void> {
    return this.connection.onModuleInit()
  }

  onModuleDestroy(): Promise<void> {
    return this.connection.onModuleDestroy()
  }

  /** Nested worker adapters share the transaction without acquiring broader tenant permissions. */
  transactional<T>(
    organizationId: string,
    computation: (cx: WorkerTransaction) => Promise<T>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    if (!isUUIDv7(organizationId)) throw new InvalidOrganizationIdError()
    // Worker process composition uses the same context as the shared workflow repositories.
    // API composition retains a separate restricted connection for worker-only operations.
    if (this.database?.runtimeRole === "approvio_worker_runtime")
      return this.database.transactional(
        organizationId,
        tx => computation(workerTransaction(tx, organizationId)),
        options
      )
    const active = this.context.getStore()
    const isolationLevel = options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted
    if (active) {
      if (active.organizationId !== organizationId)
        throw new OrganizationMismatchError(organizationId, active.organizationId)
      // A nested request may use a stronger existing snapshot, but cannot strengthen it.
      if (ISOLATION_LEVELS.indexOf(isolationLevel) > ISOLATION_LEVELS.indexOf(active.isolationLevel))
        throw new ConflictingIsolationLevelError(isolationLevel, active.isolationLevel)
      return computation(active.cx)
    }
    return this.executeWithRetry(organizationId, computation, isolationLevel)
  }

  private async executeWithRetry<T>(
    organizationId: string,
    computation: (cx: WorkerTransaction) => Promise<T>,
    isolationLevel: Prisma.TransactionIsolationLevel
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++)
      try {
        return await this.connection.transactional(
          cx => this.context.run({organizationId, cx, isolationLevel}, () => computation(cx)),
          organizationId,
          {isolationLevel}
        )
      } catch (error) {
        if (!DatabaseClient.isRetryableTransactionError(error)) throw error
        if (attempt === this.retry.maxAttempts) throw new TransactionRetryExhaustedError(error)
        const maximumDelay = Math.min(
          this.retry.initialDelayMs * Math.pow(this.retry.backoffFactor, attempt - 1),
          this.retry.maxDelayMs
        )
        const jitteredDelay = Math.floor(Math.random() * (maximumDelay + 1))
        if (jitteredDelay > 0) await new Promise(resolve => setTimeout(resolve, jitteredDelay))
      }
    throw new TransactionRetryExhaustedError(new Error("Retry loop exhausted without a captured database error"))
  }
}

@Injectable()
export class PlatformSecurityDatabaseClient extends PlatformCapabilityDatabaseClient<SecurityTransaction> {
  constructor(@Inject(ConfigProvider) config: PlatformDatabaseConfig) {
    super(config, "approvio_security_runtime", securityTransaction)
  }
}
