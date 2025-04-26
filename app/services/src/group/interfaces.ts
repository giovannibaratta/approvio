import {Group, GroupValidationError, GroupWithEntititesCount} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {PaginationError, UnknownError} from "@services/error"
import {Versioned} from "@services/shared/utils"

export type GroupCreateError = "group_already_exists" | GroupValidationError | UnknownError
export type GroupGetError = "group_not_found" | GroupValidationError | UnknownError
export type GroupListError = PaginationError | GroupValidationError | UnknownError

export interface ListGroupsResult {
  groups: GroupWithEntititesCount[]
  total: number
  page: number
  limit: number
}

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroup(group: Group): TaskEither<GroupCreateError, Group>
  getGroupById(groupId: string): TaskEither<GroupGetError, Versioned<GroupWithEntititesCount>>
  getGroupByName(groupName: string): TaskEither<GroupGetError, Versioned<GroupWithEntititesCount>>
  listGroups(page: number, limit: number): TaskEither<GroupListError, ListGroupsResult>
}
