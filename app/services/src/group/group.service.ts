import {
  Group,
  GroupFactory,
  GroupWithEntitiesCount,
  ListFilterFactory,
  MembershipFactory,
  User,
  UserFactory,
  RoleFactory,
  UserValidationError,
  RolePermissionChecker
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {MembershipAddError} from "@services/group-membership"
import {RequestorAwareRequest} from "@services/shared/types"
import {Versioned} from "@services/shared/utils"
import {isUUIDv4} from "@utils"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  CreateGroupRepoError,
  CreateGroupWithMembershipAndUpdateUserRepo,
  GetGroupRepoError,
  GROUP_REPOSITORY_TOKEN,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult
} from "./interfaces"

export type CreateGroupError = CreateGroupRepoError | MembershipAddError | UserValidationError
export type GetGroupError = GetGroupRepoError | AuthorizationError
export type ListGroupsError = ListGroupsRepoError | AuthorizationError

export const MAX_LIMIT = 100

@Injectable()
export class GroupService {
  constructor(
    @Inject(GROUP_REPOSITORY_TOKEN)
    private readonly groupRepo: GroupRepository,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository
  ) {}

  /**
   * Creates a new group and adds the requesting user as a member with manage permissions.
   * All users are allowed to create groups.
   */
  createGroup(request: CreateGroupRequest): TaskEither<CreateGroupError, Group> {
    const validateGroup = (req: CreateGroupRequest) => pipe(req.groupData, GroupFactory.newGroup, TE.fromEither)

    const fetchUser = (requestor: User) => this.userRepo.getUserById(requestor.id)

    const createMembership = (user: User) => pipe(MembershipFactory.newMembership({entity: user}), TE.fromEither)

    const addManagePermissions = ({user, group}: {user: Versioned<User>; group: Group}) => {
      const manageRole = RoleFactory.createGroupManagerRole({type: "group", groupId: group.id})
      return pipe(UserFactory.addPermissions(user, [manageRole]), TE.fromEither)
    }

    const persistGroupWithMembershipAndUpdateUser = (data: CreateGroupWithMembershipAndUpdateUserRepo) =>
      this.groupRepo.createGroupWithMembershipAndUpdateUser(data)

    return pipe(
      TE.Do,
      TE.bindW("group", () => validateGroup(request)),
      TE.bindW("user", () => fetchUser(request.requestor)),
      TE.bindW("updatedUser", ({user, group}) => addManagePermissions({user, group})),
      TE.bindW("membership", ({updatedUser}) => createMembership(updatedUser)),
      TE.chainW(({group, updatedUser, user, membership}) =>
        persistGroupWithMembershipAndUpdateUser({group, user: updatedUser, userOcc: user.occ, membership})
      )
    )
  }

  getGroupByIdentifier(
    request: GetGroupByIdentifierRequest
  ): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> {
    const {groupIdentifier, requestor} = request
    const isUuid = isUUIDv4(groupIdentifier)

    const resolveGroupId = (identifier: string): TaskEither<GetGroupError, string> => {
      return isUuid ? TE.right(identifier) : this.groupRepo.getGroupIdByName(identifier)
    }

    const checkPermissions = (groupId: string): TaskEither<GetGroupError, string> => {
      const isOrgAdmin = requestor.orgRole === "admin"
      const hasReadPermission = RolePermissionChecker.hasGroupPermission(
        requestor.roles,
        {type: "group", groupId},
        "read"
      )

      if (isOrgAdmin || hasReadPermission) return TE.right(groupId)
      return TE.left("requestor_not_authorized" as AuthorizationError)
    }

    const fetchGroupData = (groupId: string): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> => {
      return this.groupRepo.getGroupById({groupId})
    }

    return pipe(
      TE.Do,
      TE.bindW("groupId", () => resolveGroupId(groupIdentifier)),
      TE.bindW("authorizedGroupId", ({groupId}) => checkPermissions(groupId)),
      TE.chainW(({authorizedGroupId}) => fetchGroupData(authorizedGroupId))
    )
  }

  listGroups(request: ListGroupsRequest): TaskEither<ListGroupsError, ListGroupsResult> {
    const page = request.page
    let limit = request.limit

    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = MAX_LIMIT

    const repoListGroups = (data: ListGroupsRepo) => this.groupRepo.listGroups(data)

    const buildRepoRequest = (req: ListGroupsRequest) => {
      const filter = ListFilterFactory.generateListFiltersForRequestor(req.requestor)
      return {page, limit, filter}
    }

    return pipe(request, buildRepoRequest, TE.right, TE.chainW(repoListGroups))
  }
}

export interface CreateGroupRequest extends RequestorAwareRequest {
  groupData: Parameters<typeof GroupFactory.newGroup>[0]
}

export interface ListGroupsRequest extends RequestorAwareRequest {
  page: number
  limit: number
}

export interface GetGroupByIdentifierRequest extends RequestorAwareRequest {
  groupIdentifier: string
}
