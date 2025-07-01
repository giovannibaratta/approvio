import {Group, GroupValidationError, GroupWithEntitiesCount, ListGroupsFilter, User} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {PaginationError, UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"
import {MembershipAddError} from "@services/group-membership/interfaces"

export type CreateGroupRepoError = "group_already_exists" | GroupValidationError | UnknownError | MembershipAddError

export type GetGroupRepoError = "group_not_found" | "not_a_member" | GroupValidationError | UnknownError
export type ListGroupsRepoError = PaginationError | GroupValidationError | UnknownError

export interface ListGroupsResult {
  groups: GroupWithEntitiesCount[]
  total: number
  page: number
  limit: number
}

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroupWithOwner(data: CreateGroupWithOwnerRepo): TaskEither<CreateGroupRepoError, Group>
  getGroupById(data: GetGroupByIdRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupByName(data: GetGroupByNameRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  listGroups(data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult>
}

export interface CreateGroupWithOwnerRepo {
  group: Group
  requestor: User
}

export interface ListGroupsRepo {
  filter: ListGroupsFilter
  page: number
  limit: number
}

interface GetGroupRepo {
  onlyIfMember: false | {userId: string}
}

export interface GetGroupByIdRepo extends GetGroupRepo {
  groupId: string
}

export interface GetGroupByNameRepo extends GetGroupRepo {
  groupName: string
}
