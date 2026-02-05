import {Injectable} from "@nestjs/common"
import {GroupService} from "../group/group.service"
import {AuthenticatedEntity, Group} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {GetGroupRepoError} from "../group/interfaces"

@Injectable()
export class IdentityService {
  constructor(private readonly groupService: GroupService) {}

  /**
   * Get groups for the given entity (user or agent)
   */
  getIdentityGroups(entity: AuthenticatedEntity): TaskEither<GetGroupRepoError, Group[]> {
    return entity.entityType === "user"
      ? this.groupService.getUserGroups(entity.user.id)
      : this.groupService.getAgentGroups(entity.agent.id)
  }
}
