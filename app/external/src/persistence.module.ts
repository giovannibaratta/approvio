import {Module} from "@nestjs/common"
import {
  AgentDbRepository,
  AgentChallengeDbRepository,
  DatabaseClient,
  UserDbRepository,
  GroupMembershipDbRepository,
  OrganizationAdminDbRepository,
  SpaceDbRepository,
  WorkflowDbRepository,
  WorkflowTemplateDbRepository,
  VoteDbRepository,
  PkceSessionDbRepository,
  PrismaTaskRepository,
  RefreshTokenDbRepository,
  PrismaHealthRepository
} from "./database/"
import {GroupDbRepository, QuotaDbRepository} from "./database"
import {
  AGENT_REPOSITORY_TOKEN,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GROUP_REPOSITORY_TOKEN,
  QUOTA_REPOSITORY_TOKEN,
  ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
  SPACE_REPOSITORY_TOKEN,
  USER_REPOSITORY_TOKEN,
  VOTE_REPOSITORY_TOKEN,
  WORKFLOW_REPOSITORY_TOKEN,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  QUEUE_PROVIDER_TOKEN,
  HEALTH_REPOSITORY_TOKEN
} from "@services"
import {TASK_REPOSITORY_TOKEN} from "@services/task/interfaces"
import {PKCE_SESSION_REPOSITORY_TOKEN, REFRESH_TOKEN_REPOSITORY_TOKEN} from "@services/auth"
import {ConfigModule} from "./config.module"
import {QueueModule} from "./queue/queue.module"
import {BullQueueProvider} from "./queue/queue.provider"
import {RedisClient} from "./redis"

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

const organizationAdminRepository = {
  provide: ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
  useClass: OrganizationAdminDbRepository
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

const queueProvider = {
  provide: QUEUE_PROVIDER_TOKEN,
  useClass: BullQueueProvider
}

const taskRepository = {
  provide: TASK_REPOSITORY_TOKEN,
  useClass: PrismaTaskRepository
}

const refreshTokenRepository = {
  provide: REFRESH_TOKEN_REPOSITORY_TOKEN,
  useClass: RefreshTokenDbRepository
}

const healthRepository = {
  provide: HEALTH_REPOSITORY_TOKEN,
  useClass: PrismaHealthRepository
}

const quotaRepository = {
  provide: QUOTA_REPOSITORY_TOKEN,
  useClass: QuotaDbRepository
}

const repositories = [
  agentRepository,
  agentChallengeRepository,
  groupRepository,
  userRepository,
  groupMembershipRepository,
  organizationAdminRepository,
  spaceRepository,
  workflowRepository,
  workflowTemplateRepository,
  voteRepository,
  pkceSessionRepository,
  taskRepository,
  refreshTokenRepository,
  healthRepository,
  quotaRepository
]

@Module({
  imports: [ConfigModule, QueueModule],
  providers: [DatabaseClient, ...repositories, queueProvider, RedisClient],
  exports: [...repositories, queueProvider]
})
export class PersistenceModule {}
