import {Group, GroupManager, Membership, MembershipFactory, MembershipValidationError} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError, GetGroupError} from "@services"
import {RequestorAwareRequest} from "@services/shared/types"
import {Versioned} from "@services/shared/utils"
import {isUUIDv4} from "@utils"
import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  GetGroupMembershipResult,
  GetGroupWithMembershipRepo,
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GroupMembershipRepository,
  MembershipAddError,
  MembershipRemoveError,
  RemoveMembershipRepoRequest
} from "./interfaces"

export interface AddMembersToGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<{userId: string; role: string}>
}

export interface RemoveMembersFromGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<{userId: string}>
}

@Injectable()
export class GroupMembershipService {
  constructor(
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository
  ) {}

  getGroupByIdentifierWithMembership(
    request: GetGroupWithMembershipRequest
  ): TaskEither<"request_invalid_group_uuid" | GetGroupError | MembershipValidationError, GetGroupMembershipResult> {
    const {requestor} = request
    const onlyIfMember = requestor.orgRole === "admin" ? false : {userId: requestor.id}

    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (data: GetGroupWithMembershipRepo) => this.groupMembershipRepo.getGroupWithMembershipById(data)

    const validateRequest = (
      req: GetGroupWithMembershipRequest
    ): TE.TaskEither<"request_invalid_group_uuid", GetGroupWithMembershipRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      return TE.right(req)
    }

    const prepareRepoData = (req: GetGroupWithMembershipRequest): GetGroupWithMembershipRepo => ({
      groupId: req.groupId,
      onlyIfMember
    })

    return pipe(request, validateRequest, TE.map(prepareRepoData), TE.chainW(repoGetGroup))
  }

  addMembersToGroup(
    request: AddMembersToGroupRequest
  ): TaskEither<
    "request_invalid_group_uuid" | "request_invalid_user_uuid" | MembershipAddError | AuthorizationError,
    GetGroupMembershipResult
  > {
    const {requestor} = request

    const validateMembershipsToAdd = (req: AddMembersToGroupRequest) =>
      pipe(
        [...req.members],
        A.traverse(E.Applicative)(member =>
          MembershipFactory.newMembership({
            user: member.userId,
            role: member.role
          })
        ),
        TE.fromEither
      )

    const validateRequest = (
      req: AddMembersToGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_user_uuid", AddMembersToGroupRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv4(m.userId))) return TE.left("request_invalid_user_uuid" as const)
      return TE.right(req)
    }

    const fetchGroupMembershipData = (r: AddMembersToGroupRequest) =>
      this.getGroupByIdentifierWithMembership({groupId: r.groupId, requestor: r.requestor})

    const simulateAddMemberships = (data: GetGroupMembershipResult, membershipsToAdd: Readonly<Membership>[]) => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)

      if (isLeft(groupManagerEither)) return TE.left(groupManagerEither.left)

      const groupManager = groupManagerEither.right

      if (!groupManager.canUpdateMembership(requestor)) return TE.left("requestor_not_authorized" as const)

      // Check if any member to add is already in the group
      for (const membership of membershipsToAdd) {
        const addResult = groupManager.addMembership(membership)
        if (isLeft(addResult)) return TE.left(addResult.left)
      }
      return TE.right(data.group)
    }

    const persistMemberships = (group: Versioned<Group>, membershipsToAdd: Readonly<Membership>[]) =>
      this.groupMembershipRepo.addMembershipsToGroup({
        group,
        memberships: membershipsToAdd
      })

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
      TE.bindW("membershipsToAdd", ({request}) => validateMembershipsToAdd(request)),
      TE.bindW("groupMembershipData", ({request}) => fetchGroupMembershipData(request)),
      TE.bindW("group", ({groupMembershipData, membershipsToAdd}) =>
        simulateAddMemberships(groupMembershipData, membershipsToAdd)
      ),
      TE.chainW(({group, membershipsToAdd}) => persistMemberships(group, membershipsToAdd))
    )
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<
    "request_invalid_group_uuid" | "request_invalid_user_uuid" | MembershipRemoveError | AuthorizationError,
    GetGroupMembershipResult
  > {
    const {requestor} = request

    const validateRequest = (
      req: RemoveMembersFromGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_user_uuid", RemoveMembersFromGroupRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv4(m.userId))) return TE.left("request_invalid_user_uuid" as const)
      return TE.right(req)
    }

    const fetchGroupMembershipData = pipe(
      request,
      validateRequest,
      TE.chainW(r => this.getGroupByIdentifierWithMembership({groupId: r.groupId, requestor: r.requestor}))
    )

    const simulateRemoveMemberships = (data: GetGroupMembershipResult) => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)

      if (isLeft(groupManagerEither)) return TE.left(groupManagerEither.left)

      const groupManager = groupManagerEither.right

      if (!groupManager.canRemoveMembership(requestor)) return TE.left("requestor_not_authorized" as const)

      // Simulate removing each member
      for (const member of request.members) {
        const removeResult = groupManager.removeMembership(member.userId)
        if (isLeft(removeResult)) return TE.left(removeResult.left)
      }

      return TE.right({group: data.group, memberships: data.memberships})
    }

    const removeMemberships = (data: GetGroupMembershipResult) => {
      const removeRequest: RemoveMembershipRepoRequest = {
        groupId: data.group.id,
        membershipReferences: request.members.map(member => member.userId)
      }
      return this.groupMembershipRepo.removeMembershipFromGroup(removeRequest)
    }

    return pipe(fetchGroupMembershipData, TE.chainW(simulateRemoveMemberships), TE.chainW(removeMemberships))
  }
}

export interface GetGroupWithMembershipRequest extends RequestorAwareRequest {
  groupId: string
}
