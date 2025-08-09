import {Group, GroupValidationError, GroupWithEntitiesCount, ListGroupsFilter, User, Membership} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {PaginationError, UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"
import {MembershipAddError} from "@services/group-membership/interfaces"

export type CreateGroupRepoError =
  | "group_already_exists"
  | "user_not_found"
  | "concurrency_error"
  | GroupValidationError
  | UnknownError
  | MembershipAddError

export type GetGroupRepoError = "group_not_found" | GroupValidationError | UnknownError
export type ListGroupsRepoError = PaginationError | GroupValidationError | UnknownError

export interface ListGroupsResult {
  groups: GroupWithEntitiesCount[]
  total: number
  page: number
  limit: number
}

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroupWithMembershipAndUpdateUser(
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TaskEither<CreateGroupRepoError, Group>
  getGroupById(data: GetGroupByIdRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupByName(data: GetGroupByNameRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupIdByName(groupName: string): TaskEither<GetGroupRepoError, string>
  listGroups(data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult>
}

export interface CreateGroupWithMembershipAndUpdateUserRepo {
  group: Group
  user: User
  userOcc: bigint
  membership: Membership
}

export interface ListGroupsRepo {
  filter: ListGroupsFilter
  page: number
  limit: number
}

export interface GetGroupByIdRepo {
  groupId: string
}

export interface GetGroupByNameRepo {
  groupName: string
}
