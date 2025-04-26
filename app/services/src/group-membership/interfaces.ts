import {
  Group,
  GroupManagerValidationError,
  HumandGroupMembershipRole,
  Membership,
  MembershipValidationError
} from "@domain"
import {ConcurrentModificationError, UnknownError} from "@services/error"
import {GroupGetError} from "@services/group/interfaces"
import {UserGetError} from "@services/user/interfaces"
import {Versioned} from "@services/shared/utils"
import {TaskEither} from "fp-ts/TaskEither"

export type MembershipAddError =
  | GroupManagerValidationError
  | GroupGetError
  | UserGetError
  | MembershipValidationError
  | "entity_already_in_group"
  | "invalid_role"
  | UnknownError
  | ConcurrentModificationError
export type MembershipRemoveError =
  | GroupManagerValidationError
  | GroupGetError
  | UserGetError
  | MembershipValidationError
  | "entity_not_in_group"
  | UnknownError
  | ConcurrentModificationError

export interface UserEntity {
  id: string
  role: HumandGroupMembershipRole
  addedAt: Date
}

export const GROUP_MEMBERSHIP_REPOSITORY_TOKEN = "GROUP_MEMBERSHIP_REPOSITORY_TOKEN"

export interface AddMembershipRepoRequest {
  readonly group: Versioned<Group>
  readonly memberships: ReadonlyArray<Membership>
}

type UserReference = string

export interface RemoveMembershipRepoRequest {
  readonly groupId: string
  readonly membershipReferences: ReadonlyArray<UserReference>
}

interface GroupMembershipResult {
  readonly group: Versioned<Group>
  readonly memberships: ReadonlyArray<Membership>
}

export type GetGroupMembershipResult = GroupMembershipResult
export type AddMembershipResult = GroupMembershipResult
export type RemoveMembershipResult = GroupMembershipResult

export interface GroupMembershipRepository {
  getGroupWithMembershipById(
    groupId: string
  ): TaskEither<GroupGetError | MembershipValidationError, GetGroupMembershipResult>
  addMembershipsToGroup(request: AddMembershipRepoRequest): TaskEither<MembershipAddError, AddMembershipResult>
  removeMembershipFromGroup(
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult>
}
