import {Module} from "@nestjs/common"
import {GroupService} from "./group"
import {PersistenceModule} from "@external"
import {GroupMembershipService} from "./group-membership"
import {UserService} from "./user"

const services = [GroupService, GroupMembershipService, UserService]

@Module({
  imports: [PersistenceModule],
  providers: [...services],
  exports: [...services]
})
export class ServiceModule {}
