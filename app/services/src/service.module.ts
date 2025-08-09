import {Module} from "@nestjs/common"
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

const services = [
  GroupService,
  GroupMembershipService,
  UserService,
  WorkflowService,
  WorkflowTemplateService,
  DebugService,
  VoteService,
  EmailService,
  AuthService
]

const internalServices = [PkceService]

@Module({
  imports: [PersistenceModule, ThirdPartyModule, ConfigModule],
  providers: [...internalServices, ...services],
  exports: [...services]
})
export class ServiceModule {}
