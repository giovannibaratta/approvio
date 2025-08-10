import {
  AddMembershipError,
  Group,
  GroupManagerValidationError,
  Membership,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef,
  RemoveMembershipError,
  UserValidationError
} from "@domain"
import {ConcurrentModificationError, UnknownError} from "@services/error"
import {GetGroupRepoError} from "@services/group/interfaces"
import {Versioned} from "@services/shared/utils"
import {UserGetError} from "@services/user/interfaces"
import {TaskEither} from "fp-ts/TaskEither"

export type MembershipAddError =
  | GroupManagerValidationError
  | AddMembershipError
  | GetGroupRepoError
  | UserGetError
  | MembershipValidationError
  | UnknownError
  | ConcurrentModificationError
  | "membership_group_not_found"
  | "membership_user_not_found"

export type MembershipRemoveError =
  | GroupManagerValidationError
  | GetGroupRepoError
  | UserGetError
  | MembershipValidationError
  | RemoveMembershipError
  | UnknownError
  | ConcurrentModificationError

export interface UserEntity {
  id: string
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
    data: GetGroupWithMembershipRepo
  ): TaskEither<GetGroupRepoError | UserValidationError | MembershipValidationError, GetGroupMembershipResult>
  addMembershipsToGroup(request: AddMembershipRepoRequest): TaskEither<MembershipAddError, AddMembershipResult>
  removeMembershipFromGroup(
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult>
  getUserMembershipsByUserId(
    userId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  >
}

export interface GetGroupWithMembershipRepo {
  groupId: string
  onlyIfMember: false | {userId: string}
}
