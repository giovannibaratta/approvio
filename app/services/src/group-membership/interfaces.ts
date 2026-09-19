import {
  AddMembershipError,
  AgentValidationError,
  EntityReference,
  Group,
  GroupManagerValidationError,
  Membership,
  MembershipValidationError,
  MembershipValidationErrorWithGroupRef,
  MembershipWithGroupRef,
  RemoveMembershipError,
  UserValidationError,
  BoundaryError,
  TenantContext
} from "@domain"
import {ConcurrentModificationError, UnknownError} from "@services/error"
import {GetGroupRepoError} from "@services/group/interfaces"
import {Versioned} from "@domain"
import {UserGetError} from "@services/user/interfaces"
import {AgentGetError, AgentKeyDecodeError} from "@services/agent/interfaces"
import {TaskEither} from "fp-ts/TaskEither"

export type MembershipAddError =
  | BoundaryError
  | GroupManagerValidationError
  | AddMembershipError
  | GetGroupRepoError
  | UserGetError
  | AgentGetError
  | MembershipValidationError
  | UnknownError
  | ConcurrentModificationError
  | "membership_group_not_found"
  | "quota_exceeded"
  | "quota_check_error"
  | "membership_user_not_found"
  | "membership_agent_not_found"

export type MembershipRemoveError =
  | BoundaryError
  | GroupManagerValidationError
  | GetGroupRepoError
  | UserGetError
  | MembershipValidationError
  | RemoveMembershipError
  | AgentKeyDecodeError
  | AgentValidationError
  | UnknownError
  | ConcurrentModificationError

export const GROUP_MEMBERSHIP_REPOSITORY_TOKEN = "GROUP_MEMBERSHIP_REPOSITORY_TOKEN"

export interface AddMembershipRepoRequest {
  readonly group: Versioned<Group>
  readonly memberships: ReadonlyArray<Membership>
}

export interface RemoveMembershipRepoRequest {
  readonly groupId: string
  readonly entityReferences: ReadonlyArray<EntityReference>
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
    context: TenantContext,
    data: GetGroupWithMembershipRepo
  ): TaskEither<
    GetGroupRepoError | UserValidationError | MembershipValidationError | AgentKeyDecodeError | AgentValidationError,
    GetGroupMembershipResult
  >
  addMembershipsToGroup(
    context: TenantContext,
    request: AddMembershipRepoRequest
  ): TaskEither<MembershipAddError, AddMembershipResult>
  removeMembershipFromGroup(
    context: TenantContext,
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult>
  getUserMembershipsByUserId(
    context: TenantContext,
    userId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  >

  getAgentMembershipsByAgentId(
    context: TenantContext,
    agentId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  >

  countUserMembersByGroupId(context: TenantContext, groupId: string): TaskEither<UnknownError | BoundaryError, number>
  countAgentMembersByGroupId(context: TenantContext, groupId: string): TaskEither<UnknownError | BoundaryError, number>
}

export interface GetGroupWithMembershipRepo {
  groupId: string
  onlyIfMember: false | {userId: string}
}
