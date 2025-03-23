import {Group} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "@services/error"

export type GroupCreateError = "group_already_exists" | UnknownError

export const GROUP_REPOSITORY_TOKEN = "GROUP_REPOSITORY_TOKEN"

export interface GroupRepository {
  createGroup(group: Group): TaskEither<GroupCreateError, Group>
}
