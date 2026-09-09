import {Module} from "@nestjs/common"
import {
  PostgresAuditLogRepository,
  AgentDbRepository,
  AgentChallengeDbRepository,
  DatabaseClient,
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
  BrowserSessionDbRepository
} from "./database/"
import {
  GroupDbRepository,
  IdentityDatabaseClient,
  ProviderConnectionDbRepository,
  QuotaDbRepository,
  PrismaTransactionManager,
  SessionDatabaseClient,
  SchedulerDatabaseClient,
  WorkerDatabaseClient,
  TenantOutboxDbRepository,
  DispatchAdmissionDbRepository,
  OrganizationDirectoryDbRepository,
  MembershipDbRepository,
  PlatformIdentityDbRepository,
  AccountDiscoveryDbRepository,
  StepUpReceiptDbRepository
} from "./database"
import {
  AUDIT_LOG_REPOSITORY_TOKEN,
  AGENT_REPOSITORY_TOKEN,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GROUP_REPOSITORY_TOKEN,
  TRANSACTION_MANAGER_TOKEN,
  QUOTA_REPOSITORY_TOKEN,
  SPACE_REPOSITORY_TOKEN,
  USER_REPOSITORY_TOKEN,
  VOTE_REPOSITORY_TOKEN,
  WORKFLOW_REPOSITORY_TOKEN,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  QUEUE_PROVIDER_TOKEN,
  HEALTH_REPOSITORY_TOKEN,
  USAGE_EVENT_REPOSITORY_TOKEN,
  OUTBOX_REPOSITORY_TOKEN,
  DISPATCH_ADMISSION_TOKEN,
  ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  MEMBERSHIP_REPOSITORY_TOKEN,
  ACCOUNT_DISCOVERY_REPOSITORY_TOKEN,
  STEP_UP_RECEIPT_REPOSITORY_TOKEN
} from "@services"
import {PROVIDER_CONNECTION_REPOSITORY_TOKEN, SESSION_REPOSITORY_TOKEN} from "@services/tenancy/interfaces"
import {PLATFORM_IDENTITY_REPOSITORY_TOKEN} from "@services/user-identity/interfaces"
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
import {RedisQuotaAdmissionClient, RedisClient} from "./redis"

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

const transactionManager = {
  provide: TRANSACTION_MANAGER_TOKEN,
  useClass: PrismaTransactionManager
}

const providerConnectionRepository = {
  provide: PROVIDER_CONNECTION_REPOSITORY_TOKEN,
  useClass: ProviderConnectionDbRepository
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

const dispatchAdmission = {
  provide: DISPATCH_ADMISSION_TOKEN,
  useClass: DispatchAdmissionDbRepository
}

const organizationDirectoryRepository = {
  provide: ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN,
  useClass: OrganizationDirectoryDbRepository
}
const membershipRepository = {provide: MEMBERSHIP_REPOSITORY_TOKEN, useClass: MembershipDbRepository}

const repositories = [
  auditLogRepository,
  agentRepository,
  agentChallengeRepository,
  groupRepository,
  userRepository,
  groupMembershipRepository,
  spaceRepository,
  workflowRepository,
  workflowTemplateRepository,
  voteRepository,
  pkceSessionRepository,
  browserSessionRepository,
  platformIdentityRepository,
  accountDiscoveryRepository,
  stepUpReceiptRepository,
  taskRepository,
  accountRefreshTokenRepository,
  agentRefreshTokenRepository,
  healthRepository,
  quotaRepository,
  dpopTokenRepository,
  transactionManager,
  redisQuotaAdmissionClient,
  usageEventRepository,
  outboxRepository,
  dispatchAdmission,
  organizationDirectoryRepository,
  membershipRepository,
  providerConnectionRepository,
  IdentityDatabaseClient,
  SessionDatabaseClient,
  SchedulerDatabaseClient,
  WorkerDatabaseClient
]

@Module({
  imports: [ConfigModule, QueueModule, KmsModule],
  providers: [DatabaseClient, ...repositories, queueProvider, RedisClient],
  exports: [...repositories, queueProvider, transactionManager]
})
export class PersistenceModule {}
