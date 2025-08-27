import {Module} from "@nestjs/common"
import {
  DatabaseClient,
  UserDbRepository,
  GroupMembershipDbRepository,
  OrganizationAdminDbRepository,
  SpaceDbRepository,
  WorkflowDbRepository,
  WorkflowTemplateDbRepository,
  VoteDbRepository,
  PkceSessionDbRepository
} from "./database/"
import {GroupDbRepository} from "./database"
import {
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GROUP_REPOSITORY_TOKEN,
  ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
  SPACE_REPOSITORY_TOKEN,
  USER_REPOSITORY_TOKEN,
  VOTE_REPOSITORY_TOKEN,
  WORKFLOW_REPOSITORY_TOKEN,
  WORKFLOW_TEMPLATE_REPOSITORY_TOKEN
} from "@services"
import {PKCE_SESSION_REPOSITORY_TOKEN} from "@services/auth"
import {ConfigModule} from "./config.module"

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

const organizationAdminRepository = {
  provide: ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
  useClass: OrganizationAdminDbRepository
}

const spaceRepository = {
  provide: SPACE_REPOSITORY_TOKEN,
  useClass: SpaceDbRepository
}

const workflowRepository = {
  provide: WORKFLOW_REPOSITORY_TOKEN,
  useClass: WorkflowDbRepository
}

const workflowTemplateRepository = {
  provide: WORKFLOW_TEMPLATE_REPOSITORY_TOKEN,
  useClass: WorkflowTemplateDbRepository
}

const voteRepository = {
  provide: VOTE_REPOSITORY_TOKEN,
  useClass: VoteDbRepository
}

const pkceSessionRepository = {
  provide: PKCE_SESSION_REPOSITORY_TOKEN,
  useClass: PkceSessionDbRepository
}

const repositories = [
  groupRepository,
  userRepository,
  groupMembershipRepository,
  organizationAdminRepository,
  spaceRepository,
  workflowRepository,
  workflowTemplateRepository,
  voteRepository,
  pkceSessionRepository
]

@Module({
  imports: [ConfigModule],
  providers: [DatabaseClient, ...repositories],
  exports: [...repositories]
})
export class PersistenceModule {}
