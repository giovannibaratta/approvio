import {Module} from "@nestjs/common"
import {GroupService} from "./group"
import {PersistenceModule} from "@external"
import {GroupMembershipService} from "./group-membership"
import {UserService} from "./user"
import {DebugService} from "./debug"
import {WorkflowService} from "./workflow"
import {VoteService} from "./vote"

const services = [GroupService, GroupMembershipService, UserService, WorkflowService, DebugService, VoteService]

@Module({
  imports: [PersistenceModule],
  providers: [...services],
  exports: [...services]
})
export class ServiceModule {}
