import {Module} from "@nestjs/common"
import {AgentService} from "./agent"
import {GroupService} from "./group"
import {OrganizationAdminService} from "./organization-admin"
import {PersistenceModule, ThirdPartyModule} from "@external"
import {GroupMembershipService} from "./group-membership"
import {SpaceService} from "./space"
import {UserService} from "./user"
import {WorkflowService} from "./workflow"
import {WorkflowTemplateService} from "./workflow-template"
import {VoteService} from "./vote"
import {EmailService} from "./email/email.service"
import {AuthService, PkceService} from "./auth"
import {RoleService} from "./role"
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
  WorkflowTemplateService,
  VoteService,
  EmailService,
  AuthService,
  RoleService
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
  imports: [PersistenceModule, ThirdPartyModule, ConfigModule, jwtModule],
  providers: [...internalServices, ...services],
  exports: [...services]
})
export class ServiceModule {}
