import {Module} from "@nestjs/common"
import {AgentService} from "./agent"
import {GroupService} from "./group"
import {OrganizationAdminService} from "./organization-admin"
import {PersistenceModule, ThirdPartyModule, QueueModule, RateLimiterModule} from "@external"
import {GroupMembershipService} from "./group-membership"
import {SpaceService} from "./space"
import {UserService} from "./user"
import {WorkflowService} from "./workflow"
import {WorkflowRecalculationService} from "./workflow/workflow-recalculation.service"
import {TaskService} from "./task/task.service"
import {WorkflowTemplateService} from "./workflow-template"
import {VoteService} from "./vote"
import {EmailService} from "./email/email.service"
import {WebhookService} from "./webhook/webhook.service"
import {SlackService} from "./slack/slack.service"
import {AuthService, PkceService, IdentityService} from "./auth"
import {RoleService} from "./role"
import {QueueService} from "./queue"
import {HealthService} from "./health"
import {ConfigModule} from "@external/config.module"
import {ConfigProvider} from "@external/config"
import {JwtModule} from "@nestjs/jwt"
import {RateLimiterService} from "./rate-limiter"
import {QuotaService} from "./quota"
import {HierarchyService} from "./hierarchy/hierarchy.service"
import {AuditLogService} from "./audit-log"
import {LeverService} from "./lever"
import {ResourcesService} from "./resources"

const services = [
  AgentService,
  AuditLogService,
  GroupService,
  GroupMembershipService,
  OrganizationAdminService,
  SpaceService,
  UserService,
  WorkflowService,
  WorkflowRecalculationService,
  WorkflowTemplateService,
  VoteService,
  EmailService,
  WebhookService,
  SlackService,
  AuthService,
  RoleService,
  QueueService,
  TaskService,
  IdentityService,
  HealthService,
  RateLimiterService,
  QuotaService,
  HierarchyService,
  LeverService,
  ResourcesService
]

const internalServices = [PkceService]

const jwtModule = JwtModule.registerAsync({
  global: false,
  imports: [ConfigModule],
  useFactory: (configProvider: ConfigProvider) => ({
    secret: configProvider.jwtConfig.secret,
    signOptions: {expiresIn: "60s"}
  }),
  inject: [ConfigProvider]
})

@Module({
  imports: [PersistenceModule, ThirdPartyModule, ConfigModule, QueueModule, jwtModule, RateLimiterModule],
  providers: [...internalServices, ...services],
  exports: [...services]
})
export class ServiceModule {}
