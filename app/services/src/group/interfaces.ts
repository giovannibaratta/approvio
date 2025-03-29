import {Group, GroupValidationError} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"

export type GroupCreateError = "group_already_exists" | GroupValidationError | UnknownError
export type GroupGetError = "group_not_found" | GroupValidationError | UnknownError
export type GroupListError = "invalid_page" | "invalid_limit" | GroupValidationError | UnknownError

export interface ListGroupsResult {
  groups: Group[]
  total: number
  page: number
  limit: number
}

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroup(group: Group): TaskEither<GroupCreateError, Group>
  getGroupById(groupId: string): TaskEither<GroupGetError, Group>
  getGroupByName(groupName: string): TaskEither<GroupGetError, Group>
  listGroups(page: number, limit: number): TaskEither<GroupListError, ListGroupsResult>
}
