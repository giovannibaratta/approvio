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

const services = [
  GroupService,
  GroupMembershipService,
  UserService,
  WorkflowService,
  WorkflowTemplateService,
  DebugService,
  VoteService,
  EmailService
]

@Module({
  imports: [PersistenceModule, ThirdPartyModule],
  providers: [...services],
  exports: [...services]
})
export class ServiceModule {}
