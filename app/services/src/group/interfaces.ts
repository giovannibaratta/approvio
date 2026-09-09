import {
  BoundaryError,
  Group,
  GroupValidationError,
  GroupWithEntitiesCount,
  ListGroupsFilter,
  Membership,
  TenantContext,
  User
} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {PaginationError, UnknownError} from "@services/error"
import {Versioned} from "@domain"

export type CreateGroupRepoError =
  BoundaryError | "group_already_exists" | "user_not_found" | "concurrency_error" | GroupValidationError | UnknownError

export type GetGroupRepoError = BoundaryError | "group_not_found" | GroupValidationError | UnknownError
export type ListGroupsRepoError = BoundaryError | PaginationError | GroupValidationError | UnknownError

export interface ListGroupsResult {
  groups: GroupWithEntitiesCount[]
  total: number
  page: number
  limit: number
}

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroupWithMembershipAndUpdateUser(
    context: TenantContext,
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TaskEither<CreateGroupRepoError, Group>
  getGroupById(
    context: TenantContext,
    data: GetGroupByIdRepo
  ): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupByName(
    context: TenantContext,
    data: GetGroupByNameRepo
  ): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupIdByName(context: TenantContext, groupName: string): TaskEither<GetGroupRepoError, string>
  getGroupsByIds(
    context: TenantContext,
    groupIds: string[]
  ): TaskEither<UnknownError | BoundaryError, {id: string; name: string}[]>
  listGroups(context: TenantContext, data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult>
  /**
   * Get all groups the user is a member of
   * @param userId The user ID
   */
  getGroupsByUserId(context: TenantContext, userId: string): TaskEither<GetGroupRepoError, Group[]>
  /**
   * Get all groups the agent is a member of
   * @param agentId The agent ID
   */
  getGroupsByAgentId(context: TenantContext, agentId: string): TaskEither<GetGroupRepoError, Group[]>
  countGroups(context: TenantContext): TaskEither<UnknownError | BoundaryError, number>
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
