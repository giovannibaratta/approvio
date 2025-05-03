import {Group, GroupManager, MembershipFactory, MembershipValidationError} from "@domain" // Add User
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError, GetGroupError} from "@services"
import {RequestorAwareRequest} from "@services/shared/types"
import {Versioned} from "@services/shared/utils"
import {isUUID} from "@services/shared/validation"
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
  ): TaskEither<
    "invalid_page" | "invalid_limit" | GetGroupError | MembershipValidationError,
    GetGroupMembershipResult
  > {
    const {requestor} = request
    const onlyIfMember = requestor.orgRole === "admin" ? false : {userId: requestor.id}

    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (data: GetGroupWithMembershipRepo) => this.groupMembershipRepo.getGroupWithMembershipById(data)

    const validateRequest = (
      req: GetGroupWithMembershipRequest
    ): TE.TaskEither<"invalid_uuid", GetGroupWithMembershipRequest> => {
      if (!isUUID(req.groupId)) return TE.left("invalid_uuid" as const)
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
  ): TaskEither<MembershipAddError | AuthorizationError, GetGroupMembershipResult> {
    const {requestor} = request

    const membershipsToAdd = pipe(
      [...request.members],
      A.traverse(E.Applicative)(member =>
        MembershipFactory.newMembership({
          user: member.userId,
          role: member.role
        })
      )
    )

    if (isLeft(membershipsToAdd)) return TE.left(membershipsToAdd.left)

    const validateRequest = (req: AddMembersToGroupRequest): TE.TaskEither<"invalid_uuid", AddMembersToGroupRequest> =>
      isUUID(req.groupId) ? TE.right(req) : TE.left("invalid_uuid" as const)

    const fetchGroupMembershipData = pipe(
      request,
      validateRequest,
      TE.chainW(r => this.getGroupByIdentifierWithMembership({groupId: r.groupId, requestor: r.requestor}))
    )

    const simulateAddMemberships = (data: GetGroupMembershipResult) => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)

      if (isLeft(groupManagerEither)) return TE.left(groupManagerEither.left)

      const groupManager = groupManagerEither.right

      if (!groupManager.canUpdateMembership(requestor)) return TE.left("requestor_not_authorized" as const)

      // Check if any member to add is already in the group
      for (const membership of membershipsToAdd.right) {
        if (groupManager.isEntityInMembership(membership.getEntityId()))
          return TE.left("entity_already_in_group" as const)
      }

      return TE.right(data.group)
    }

    const persistMemberships = (group: Versioned<Group>) =>
      this.groupMembershipRepo.addMembershipsToGroup({
        group,
        memberships: membershipsToAdd.right
      })

    return pipe(fetchGroupMembershipData, TE.chainW(simulateAddMemberships), TE.chainW(persistMemberships))
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<MembershipRemoveError | AuthorizationError, GetGroupMembershipResult> {
    const {requestor} = request

    const validateRequest = (
      req: RemoveMembersFromGroupRequest
    ): TE.TaskEither<"invalid_uuid", RemoveMembersFromGroupRequest> =>
      isUUID(req.groupId) && req.members.every(m => isUUID(m.userId)) ? TE.right(req) : TE.left("invalid_uuid" as const)

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
