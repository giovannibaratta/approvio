import {
  Group,
  GroupFactory,
  GroupWithEntitiesCount,
  ListFilterFactory,
  MembershipFactory,
  User,
  UserFactory,
  SystemRole,
  UserValidationError,
  createUserMembershipEntity,
  RolePermissionChecker
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {MembershipAddError} from "@services/group-membership"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"
import {Versioned} from "@domain"
import {isUUIDv4, logSuccess} from "@utils"
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

export type CreateGroupError = CreateGroupRepoError | MembershipAddError | UserValidationError | AuthorizationError
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
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const validateGroup = (req: CreateGroupRequest) => pipe(req.groupData, GroupFactory.newGroup, TE.fromEither)

    const fetchUser = (requestor: User) => this.userRepo.getUserById(requestor.id)

    const createMembership = (user: User) =>
      pipe(MembershipFactory.newMembership({entity: createUserMembershipEntity(user)}), TE.fromEither)

    const addManagePermissions = ({user, group}: {user: Versioned<User>; group: Group}) => {
      const manageRole = SystemRole.createGroupManagerRole({type: "group", groupId: group.id})
      return pipe(UserFactory.addPermissions(user, [manageRole]), TE.fromEither)
    }

    const persistGroupWithMembershipAndUpdateUser = (data: CreateGroupWithMembershipAndUpdateUserRepo) =>
      this.groupRepo.createGroupWithMembershipAndUpdateUser(data)

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("group", () => validateGroup(request)),
      TE.bindW("user", ({requestor}) => fetchUser(requestor)),
      TE.bindW("updatedUser", ({user, group}) => addManagePermissions({user, group})),
      TE.bindW("membership", ({updatedUser}) => createMembership(updatedUser)),
      TE.chainW(({group, updatedUser, user, membership}) =>
        persistGroupWithMembershipAndUpdateUser({group, user: updatedUser, userOcc: user.occ, membership})
      ),
      logSuccess("Group created", "GroupService", group => ({id: group.id, name: group.name}))
    )
  }

  getGroupByIdentifier(
    request: GetGroupByIdentifierRequest
  ): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> {
    const {groupIdentifier} = request
    const isUuid = isUUIDv4(groupIdentifier)

    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const resolveGroupId = (identifier: string): TaskEither<GetGroupError, string> => {
      return isUuid ? TE.right(identifier) : this.groupRepo.getGroupIdByName(identifier)
    }

    const checkPermissions = (requestor: User, groupId: string): TaskEither<GetGroupError, string> => {
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
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("groupId", () => resolveGroupId(groupIdentifier)),
      TE.bindW("authorizedGroupId", ({requestor, groupId}) => checkPermissions(requestor, groupId)),
      TE.chainW(({authorizedGroupId}) => fetchGroupData(authorizedGroupId)),
      logSuccess("Group retrieved", "GroupService", group => ({id: group.id}))
    )
  }

  listGroups(request: ListGroupsRequest): TaskEither<ListGroupsError, ListGroupsResult> {
    const page = request.page
    let limit = request.limit

    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = MAX_LIMIT

    const repoListGroups = (data: ListGroupsRepo) => this.groupRepo.listGroups(data)
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const buildRepoRequest = (requestor: User) => {
      const filter = ListFilterFactory.generateListFiltersForRequestor(requestor)
      return {page, limit, filter}
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("validatedRequestor", validateRequestor),
      TE.map(({validatedRequestor}) => buildRepoRequest(validatedRequestor)),
      TE.chainW(repoListGroups),
      logSuccess("Groups listed", "GroupService", result => ({count: result.groups.length, total: result.total}))
    )
  }

  getUserGroups(userId: string): TaskEither<GetGroupRepoError, Group[]> {
    return this.groupRepo.getGroupsByUserId(userId)
  }

  getAgentGroups(agentId: string): TaskEither<GetGroupRepoError, Group[]> {
    return this.groupRepo.getGroupsByAgentId(agentId)
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
