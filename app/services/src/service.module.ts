import {Module} from "@nestjs/common"
import {AgentService} from "./agent"
import {GroupService} from "./group"
import {OrganizationAdminService} from "./organization-admin"
import {PersistenceModule, ThirdPartyModule, QueueModule} from "@external"
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
import {AuthService, PkceService} from "./auth"
import {RoleService} from "./role"
import {QueueService} from "./queue"
import {ConfigModule} from "@external/config.module"
import {ConfigProvider} from "@external/config"
import {JwtModule} from "@nestjs/jwt"

const services = [
  AgentService,
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
  AuthService,
  RoleService,
  QueueService,
  TaskService
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
  imports: [PersistenceModule, ThirdPartyModule, ConfigModule, QueueModule, jwtModule],
  providers: [...internalServices, ...services],
  exports: [...services]
})
export class ServiceModule {}
