import {Module} from "@nestjs/common"
import {Config} from "./config/config"
import {
  DatabaseClient,
  UserDbRepository,
  GroupMembershipDbRepository,
  WorkflowDbRepository,
  VoteDbRepository
} from "./database/"
import {GroupDbRepository} from "./database"
import {
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GROUP_REPOSITORY_TOKEN,
  USER_REPOSITORY_TOKEN,
  VOTE_REPOSITORY_TOKEN,
  WORKFLOW_REPOSITORY_TOKEN
} from "@services"

const groupRepository = {
  provide: GROUP_REPOSITORY_TOKEN,
  useClass: GroupDbRepository
}

const userRepository = {
  provide: USER_REPOSITORY_TOKEN,
  useClass: UserDbRepository
}

const groupMembershipRepository = {
  provide: GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  useClass: GroupMembershipDbRepository
}

const workflowRepository = {
  provide: WORKFLOW_REPOSITORY_TOKEN,
  useClass: WorkflowDbRepository
}

const voteRepository = {
  provide: VOTE_REPOSITORY_TOKEN,
  useClass: VoteDbRepository
}

const repositories = [groupRepository, userRepository, groupMembershipRepository, workflowRepository, voteRepository]

@Module({
  imports: [],
  providers: [DatabaseClient, Config, ...repositories],
  exports: [...repositories]
})
export class PersistenceModule {}
