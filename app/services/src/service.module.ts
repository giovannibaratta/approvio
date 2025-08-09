import {Module} from "@nestjs/common"
import {JwtModule} from "@nestjs/jwt"
import {GroupService} from "./group"
import {PersistenceModule, ThirdPartyModule} from "@external"
import {GroupMembershipService} from "./group-membership"
import {UserService} from "./user"
import {DebugService} from "./debug"
import {WorkflowService} from "./workflow"
import {WorkflowTemplateService} from "./workflow-template"
import {VoteService} from "./vote"
import {EmailService} from "./email/email.service"
import {AuthService, PkceService} from "./auth"
import {ConfigModule} from "@external/config.module"
import {ConfigProvider} from "@external/config"

const services = [
  GroupService,
  GroupMembershipService,
  UserService,
  WorkflowService,
  WorkflowTemplateService,
  DebugService,
  VoteService,
  EmailService,
  AuthService,
  PkceService
]

@Module({
  imports: [
    PersistenceModule,
    ThirdPartyModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configProvider: ConfigProvider) => ({
        secret: configProvider.jwtConfig.secret,
        // TODO: Check if it is possible to move in inside the service.
        signOptions: {expiresIn: "1h"}
      }),
      inject: [ConfigProvider]
    })
  ],
  providers: [...services],
  exports: [...services, JwtModule]
})
export class ServiceModule {}
