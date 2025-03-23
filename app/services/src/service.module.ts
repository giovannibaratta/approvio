import {Module} from "@nestjs/common"
import {GroupService} from "./group"
import {PersistenceModule} from "@external"

@Module({
  imports: [PersistenceModule],
  providers: [GroupService],
  exports: [GroupService]
})
export class ServiceModule {}
