import {Module} from "@nestjs/common"
import {Config} from "./config/config"
import {DatabaseClient} from "./database/"
import {GroupDbRepository} from "./database"
import {GROUP_REPOSITORY_TOKEN} from "@services/group/interfaces"

const groupRepository = {
  provide: GROUP_REPOSITORY_TOKEN,
  useClass: GroupDbRepository
}

@Module({
  imports: [],
  providers: [DatabaseClient, Config, groupRepository],
  exports: [groupRepository]
})
export class PersistenceModule {}
