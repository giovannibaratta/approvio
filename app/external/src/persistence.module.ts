import {WorkerOrganizationStatusDbRepository} from "./database/worker-organization-status.repository"
import {ORGANIZATION_STATUS_REPOSITORY_TOKEN} from "@services/tenancy/interfaces"
import {PrismaWorkerTransactionManager} from "./database/worker-transaction-manager"
import {DynamicModule, Module} from "@nestjs/common"
import {
  PostgresAuditLogRepository,
  AgentDbRepository,
  AgentChallengeDbRepository,
  DatabaseClient,
  DATABASE_RUNTIME_ROLE_TOKEN,
  UserDbRepository,
  GroupMembershipDbRepository,
  SpaceDbRepository,
  WorkflowDbRepository,
  WorkflowTemplateDbRepository,
  VoteDbRepository,
  PkceSessionDbRepository,
  PrismaTaskRepository,
  AccountRefreshTokenDbRepository,
  AgentRefreshTokenDbRepository,
  PrismaHealthRepository,
  PostgresUsageEventRepository,
  BrowserSessionDbRepository,
  EventReceiptDbRepository,
  UsageOperationDbRepository
} from "./database/"
import {
  GroupDbRepository,
  IdentityDatabaseClient,
  QuotaDbRepository,
  PrismaTransactionManager,
  SessionDatabaseClient,
  SchedulerDatabaseClient,
  WorkerDatabaseClient,
  TenantOutboxDbRepository,
  EventReceiptTenantClient,
  DispatchDbRepository,
  OrganizationDirectoryDbRepository,
  OrganizationEntitlementDbRepository,
  MembershipDbRepository,
  PlatformIdentityDbRepository,
  AccountDiscoveryDbRepository,
  StepUpReceiptDbRepository,
  OrganizationProvisionerDbRepository,
  LifecycleDbRepository,
  InvitationDbRepository,
  PlatformSecurityEventDbRepository,
  DiscoveryDatabaseClient,
  PlatformSecurityDatabaseClient
} from "./database"
import {
  AgentChallengeTenantClient,
  AgentRefreshTokenTenantClient,
  AgentTenantClient,
  AuditLogTenantClient,
  GroupMembershipTenantClient,
  GroupTenantClient,
  InvitationTenantClient,
  LifecycleTenantClient,
  MembershipTenantClient,
  OrganizationDirectoryTenantClient,
  OrganizationProvisionerTenantClient,
  QuotaTenantClient,
  SpaceTenantClient,
  StepUpReceiptTenantClient,
  TenantOutboxTenantClient,
  UsageEventTenantClient,
  UsageOperationTenantClient,
  UserTenantClient,
  VoteTenantClient,
  WorkflowTemplateTenantClient,
  WorkflowTenantClient
} from "./database/tenant-database-clients"
import {
  AUDIT_LOG_REPOSITORY_TOKEN,
  AGENT_REPOSITORY_TOKEN,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GROUP_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  WORKER_TRANSACTION_MANAGER_TOKEN,
  QUOTA_REPOSITORY_TOKEN,
  SPACE_REPOSITORY_TOKEN,
  USER_REPOSITORY_TOKEN,
  VOTE_REPOSITORY_TOKEN,
  WORKFLOW_REPOSITORY_TOKEN,
  WORKFLOW_EXPIRATION_SCHEDULE_REPOSITORY_TOKEN,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  QUEUE_PROVIDER_TOKEN,
  HEALTH_REPOSITORY_TOKEN,
  USAGE_EVENT_REPOSITORY_TOKEN,
  OUTBOX_REPOSITORY_TOKEN,
  EVENT_RECEIPT_REPOSITORY_TOKEN,
  USAGE_OPERATION_REPOSITORY_TOKEN,
  DISPATCH_REPOSITORY_TOKEN,
  DISPATCH_LEASE_CLIENT_TOKEN,
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN,
  MEMBERSHIP_REPOSITORY_TOKEN,
  ACCOUNT_DISCOVERY_REPOSITORY_TOKEN,
  ORGANIZATION_PROVISIONER_TOKEN,
  LIFECYCLE_REPOSITORY_TOKEN,
  STEP_UP_RECEIPT_REPOSITORY_TOKEN
} from "@services"
import {SESSION_REPOSITORY_TOKEN} from "@services/tenancy/interfaces"
import {INVITATION_REPOSITORY_TOKEN} from "@services/tenancy/interfaces"
import {PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN} from "@services/platform-security"
import {PLATFORM_IDENTITY_REPOSITORY_TOKEN} from "@services/tenancy/interfaces"
import {TASK_REPOSITORY_TOKEN} from "@services/task/interfaces"
import {
  PKCE_SESSION_REPOSITORY_TOKEN,
  ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  DPOP_TOKEN_REPOSITORY_TOKEN
} from "@services/auth"
import {ConfigModule} from "./config.module"
import {QueueModule} from "./queue/queue.module"
import {KmsModule} from "./kms/kms.module"
import {BullQueueProvider} from "./queue/queue.provider"
import {RedisDpopTokenRepository} from "./auth/dpop-token.provider"
import {QUOTA_ADMISSION_CLIENT_TOKEN} from "@services/usage-metering"
import {RedisQuotaAdmissionClient, RedisDispatchLeaseClient, RedisClient} from "./redis"

const agentRepository = {
  provide: AGENT_REPOSITORY_TOKEN,
  useClass: AgentDbRepository
}

const agentChallengeRepository = {
  provide: AGENT_CHALLENGE_REPOSITORY_TOKEN,
  useClass: AgentChallengeDbRepository
}

const groupRepository = {
  provide: GROUP_REPOSITORY_TOKEN,
  useClass: GroupDbRepository
}

const userRepository = {
  provide: USER_REPOSITORY_TOKEN,
  useClass: UserDbRepository
}

const groupMembershipRepository = {
  provide: GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  useClass: GroupMembershipDbRepository
}

const spaceRepository = {
  provide: SPACE_REPOSITORY_TOKEN,
  useClass: SpaceDbRepository
}

const workflowRepository = {
  provide: WORKFLOW_REPOSITORY_TOKEN,
  useClass: WorkflowDbRepository
}

const workflowExpirationScheduleRepository = {
  provide: WORKFLOW_EXPIRATION_SCHEDULE_REPOSITORY_TOKEN,
  useExisting: WORKFLOW_REPOSITORY_TOKEN
}

const workflowTemplateRepository = {
  provide: WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  useClass: WorkflowTemplateDbRepository
}

const voteRepository = {
  provide: VOTE_REPOSITORY_TOKEN,
  useClass: VoteDbRepository
}

const pkceSessionRepository = {
  provide: PKCE_SESSION_REPOSITORY_TOKEN,
  useClass: PkceSessionDbRepository
}
const browserSessionRepository = {provide: SESSION_REPOSITORY_TOKEN, useClass: BrowserSessionDbRepository}

const platformIdentityRepository = {
  provide: PLATFORM_IDENTITY_REPOSITORY_TOKEN,
  useClass: PlatformIdentityDbRepository
}

const accountDiscoveryRepository = {
  provide: ACCOUNT_DISCOVERY_REPOSITORY_TOKEN,
  useClass: AccountDiscoveryDbRepository
}

const organizationProvisionerRepository = {
  provide: ORGANIZATION_PROVISIONER_TOKEN,
  useClass: OrganizationProvisionerDbRepository
}

const lifecycleRepository = {provide: LIFECYCLE_REPOSITORY_TOKEN, useClass: LifecycleDbRepository}
const invitationRepository = {provide: INVITATION_REPOSITORY_TOKEN, useClass: InvitationDbRepository}
const platformSecurityEventRepository = {
  provide: PLATFORM_SECURITY_EVENT_REPOSITORY_TOKEN,
  useClass: PlatformSecurityEventDbRepository
}

const stepUpReceiptRepository = {
  provide: STEP_UP_RECEIPT_REPOSITORY_TOKEN,
  useClass: StepUpReceiptDbRepository
}

const queueProvider = {
  provide: QUEUE_PROVIDER_TOKEN,
  useClass: BullQueueProvider
}

const taskRepository = {
  provide: TASK_REPOSITORY_TOKEN,
  useClass: PrismaTaskRepository
}

const accountRefreshTokenRepository = {
  provide: ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  useClass: AccountRefreshTokenDbRepository
}

const agentRefreshTokenRepository = {
  provide: AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  useClass: AgentRefreshTokenDbRepository
}

const healthRepository = {
  provide: HEALTH_REPOSITORY_TOKEN,
  useClass: PrismaHealthRepository
}

const quotaRepository = {
  provide: QUOTA_REPOSITORY_TOKEN,
  useClass: QuotaDbRepository
}

const dpopTokenRepository = {
  provide: DPOP_TOKEN_REPOSITORY_TOKEN,
  useClass: RedisDpopTokenRepository
}

const workerTransactionManager = {
  provide: WORKER_TRANSACTION_MANAGER_TOKEN,
  useClass: PrismaWorkerTransactionManager
}

const transactionManager = {
  provide: TRANSACTION_MANAGER_TOKEN,
  useClass: PrismaTransactionManager
}

const auditLogRepository = {
  provide: AUDIT_LOG_REPOSITORY_TOKEN,
  useClass: PostgresAuditLogRepository
}

const redisQuotaAdmissionClient = {
  provide: QUOTA_ADMISSION_CLIENT_TOKEN,
  useClass: RedisQuotaAdmissionClient
}

const usageEventRepository = {
  provide: USAGE_EVENT_REPOSITORY_TOKEN,
  useClass: PostgresUsageEventRepository
}

const outboxRepository = {
  provide: OUTBOX_REPOSITORY_TOKEN,
  useClass: TenantOutboxDbRepository
}

const eventReceiptRepository = {
  provide: EVENT_RECEIPT_REPOSITORY_TOKEN,
  useClass: EventReceiptDbRepository
}

const usageOperationRepository = {
  provide: USAGE_OPERATION_REPOSITORY_TOKEN,
  useClass: UsageOperationDbRepository
}

const dispatchRepository = {
  provide: DISPATCH_REPOSITORY_TOKEN,
  useClass: DispatchDbRepository
}

const dispatchLeaseClient = {
  provide: DISPATCH_LEASE_CLIENT_TOKEN,
  useClass: RedisDispatchLeaseClient
}

const organizationDirectoryRepository = {
  provide: ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  useClass: OrganizationDirectoryDbRepository
}
const organizationEntitlementRepository = {
  provide: ORGANIZATION_ENTITLEMENT_REPOSITORY_TOKEN,
  useClass: OrganizationEntitlementDbRepository
}
const membershipRepository = {provide: MEMBERSHIP_REPOSITORY_TOKEN, useClass: MembershipDbRepository}

const organizationStatusRepository = {
  provide: ORGANIZATION_STATUS_REPOSITORY_TOKEN,
  useClass: WorkerOrganizationStatusDbRepository
}

const repositories = [
  auditLogRepository,
  agentRepository,
  agentChallengeRepository,
  groupRepository,
  userRepository,
  groupMembershipRepository,
  spaceRepository,
  workflowRepository,
  workflowExpirationScheduleRepository,
  workflowTemplateRepository,
  voteRepository,
  pkceSessionRepository,
  browserSessionRepository,
  platformIdentityRepository,
  accountDiscoveryRepository,
  organizationProvisionerRepository,
  lifecycleRepository,
  invitationRepository,
  stepUpReceiptRepository,
  LifecycleDbRepository,
  platformSecurityEventRepository,
  taskRepository,
  accountRefreshTokenRepository,
  agentRefreshTokenRepository,
  healthRepository,
  quotaRepository,
  dpopTokenRepository,
  transactionManager,
  workerTransactionManager,
  organizationStatusRepository,
  redisQuotaAdmissionClient,
  usageEventRepository,
  outboxRepository,
  eventReceiptRepository,
  usageOperationRepository,
  dispatchRepository,
  dispatchLeaseClient,
  organizationDirectoryRepository,
  organizationEntitlementRepository,
  membershipRepository,
  IdentityDatabaseClient,
  SessionDatabaseClient,
  DiscoveryDatabaseClient,
  PlatformSecurityDatabaseClient,
  SchedulerDatabaseClient,
  WorkerDatabaseClient
]

const tenantDatabaseClients = [
  AgentChallengeTenantClient,
  AgentRefreshTokenTenantClient,
  AgentTenantClient,
  AuditLogTenantClient,
  GroupMembershipTenantClient,
  GroupTenantClient,
  InvitationTenantClient,
  LifecycleTenantClient,
  MembershipTenantClient,
  OrganizationDirectoryTenantClient,
  OrganizationProvisionerTenantClient,
  QuotaTenantClient,
  SpaceTenantClient,
  StepUpReceiptTenantClient,
  EventReceiptTenantClient,
  TenantOutboxTenantClient,
  UsageEventTenantClient,
  UsageOperationTenantClient,
  UserTenantClient,
  VoteTenantClient,
  WorkflowTemplateTenantClient,
  WorkflowTenantClient
]

@Module({
  imports: [ConfigModule, QueueModule, KmsModule],
  providers: [DatabaseClient, ...tenantDatabaseClients, ...repositories, queueProvider, RedisClient],
  exports: [...repositories, queueProvider, transactionManager]
})
export class PersistenceModule {
  // Nest identifies dynamic modules by reference; repeated imports must share one definition per runtime.
  private static readonly modules: Partial<Record<"api" | "worker", DynamicModule>> = {}

  static register(options: {runtime: "api" | "worker"}): DynamicModule {
    return (this.modules[options.runtime] ??= {
      module: PersistenceModule,
      providers: [
        {
          provide: DATABASE_RUNTIME_ROLE_TOKEN,
          useValue: options.runtime === "worker" ? "approvio_worker_runtime" : "approvio_tenant_runtime"
        }
      ]
    })
  }
}
