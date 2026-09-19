import {Inject, Injectable, OnModuleDestroy, OnModuleInit} from "@nestjs/common"
import {Prisma} from "@prisma/client"
import {ConfigProvider} from "../config"
import {DatabaseClient} from "./database-client"
import {WORKER_DATABASE_CORE_TOKEN} from "./worker-database-core.token"
import {GlobalDatabaseRole} from "./transaction-context"

type DatabaseConfig = Pick<ConfigProvider, "databaseConfig">

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
  | "tenantEventReceipt"
> & {
  readonly organization: Pick<Prisma.TransactionClient["organization"], "findUnique">
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

function workerTransaction(tx: Prisma.TransactionClient): WorkerTransaction {
  return {
    durableWork: tx.durableWork,
    workflowActionsEmailTask: tx.workflowActionsEmailTask,
    workflowActionsWebhookTask: tx.workflowActionsWebhookTask,
    workflowActionsSlackTask: tx.workflowActionsSlackTask,
    tenantOutbox: tx.tenantOutbox,
    dispatchAttempt: tx.dispatchAttempt,

    organization: {findUnique: tx.organization.findUnique.bind(tx.organization)},

    tenantEventReceipt: tx.tenantEventReceipt
  }
}

function securityTransaction(tx: Prisma.TransactionClient): SecurityTransaction {
  return {platformSecurityEvent: tx.platformSecurityEvent}
}

/** Organization-independent capabilities project a restricted API over the shared client. */
abstract class GlobalCapabilityDatabaseClient<TTransaction> implements OnModuleInit, OnModuleDestroy {
  private readonly database: DatabaseClient

  protected constructor(
    config: DatabaseConfig,
    role: GlobalDatabaseRole,
    private readonly createTransaction: (tx: Prisma.TransactionClient) => TTransaction
  ) {
    this.database = new DatabaseClient(config, role)
  }

  onModuleInit(): Promise<void> {
    return this.database.onModuleInit()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.onModuleDestroy()
  }

  transactional<T>(computation: (cx: TTransaction) => Promise<T>): Promise<T> {
    return this.database.transactional({type: "global"}, tx => computation(this.createTransaction(tx)))
  }
}

@Injectable()
export class IdentityDatabaseClient extends GlobalCapabilityDatabaseClient<IdentityTransaction> {
  constructor(@Inject(ConfigProvider) config: DatabaseConfig) {
    super(config, "approvio_identity_runtime", identityTransaction)
  }
}

@Injectable()
export class SessionDatabaseClient extends GlobalCapabilityDatabaseClient<SessionTransaction> {
  constructor(@Inject(ConfigProvider) config: DatabaseConfig) {
    super(config, "approvio_session_runtime", sessionTransaction)
  }
}

@Injectable()
export class DiscoveryDatabaseClient extends GlobalCapabilityDatabaseClient<DiscoveryTransaction> {
  constructor(@Inject(ConfigProvider) config: DatabaseConfig) {
    super(config, "approvio_discovery_runtime", discoveryTransaction)
  }
}

@Injectable()
export class SchedulerDatabaseClient extends GlobalCapabilityDatabaseClient<SchedulerTransaction> {
  constructor(@Inject(ConfigProvider) config: DatabaseConfig) {
    super(config, "approvio_scheduler_runtime", schedulerTransaction)
  }
}

@Injectable()
export class WorkerDatabaseClient {
  constructor(
    @Inject(WORKER_DATABASE_CORE_TOKEN)
    private readonly database: Pick<DatabaseClient, "transactional">
  ) {}

  transactional<T>(
    organizationId: string,
    computation: (cx: WorkerTransaction) => Promise<T>,
    options?: {isolationLevel?: Prisma.TransactionIsolationLevel}
  ): Promise<T> {
    return this.database.transactional(
      {type: "organization", organizationId},
      tx => computation(workerTransaction(tx)),
      options
    )
  }
}

@Injectable()
export class PlatformSecurityDatabaseClient extends GlobalCapabilityDatabaseClient<SecurityTransaction> {
  constructor(@Inject(ConfigProvider) config: DatabaseConfig) {
    super(config, "approvio_security_runtime", securityTransaction)
  }
}
