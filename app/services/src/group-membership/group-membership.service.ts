import {Group, GroupManager, MembershipFactory, MembershipValidationError} from "@domain" // Add User
import {Inject, Injectable} from "@nestjs/common"
import {
  GetGroupMembershipResult as GetGroupMembershipResult,
  GROUP_MEMBERSHIP_REPOSITORY_TOKEN,
  GroupMembershipRepository,
  MembershipAddError,
  MembershipRemoveError,
  RemoveMembershipRepoRequest
} from "./interfaces"
import {Versioned} from "@services/shared/utils"
import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {GetGroupError} from "@services"
import {isUUID} from "@services/shared/validation"

export interface AddMembersToGroupRequest {
  groupId: string
  members: ReadonlyArray<{userId: string; role: string}>
}

export interface RemoveMembersFromGroupRequest {
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
    groupId: string
  ): TaskEither<GetGroupError | MembershipValidationError, GetGroupMembershipResult> {
    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (value: string) => this.groupMembershipRepo.getGroupWithMembershipById(value)
    const isValidUUID = (value: string): TE.TaskEither<"invalid_uuid", string> =>
      isUUID(value) ? TE.right(value) : TE.left("invalid_uuid" as const)

    return pipe(groupId, isValidUUID, TE.chainW(repoGetGroup))
  }

  addMembersToGroup(request: AddMembersToGroupRequest): TaskEither<MembershipAddError, GetGroupMembershipResult> {
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

    const versionedGroup = pipe(
      request,
      validateRequest,
      TE.chainW(r => this.getGroupByIdentifierWithMembership(r.groupId)),
      TE.chainW(data => {
        const eitherGroupManager = GroupManager.createGroupManager(data.group, data.memberships)
        if (isLeft(eitherGroupManager)) return TE.left(eitherGroupManager.left)
        const groupManager = eitherGroupManager.right

        for (const member of request.members) {
          if (groupManager.isEntityInMembership(member.userId)) return TE.left("entity_already_in_group" as const)
        }

        return TE.right(data.group)
      })
    )

    const persistMemberships = (group: Versioned<Group>) =>
      this.groupMembershipRepo.addMembershipsToGroup({
        group,
        memberships: membershipsToAdd.right
      })

    return pipe(versionedGroup, TE.chainW(persistMemberships))
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<MembershipRemoveError, GetGroupMembershipResult> {
    const removeMemberships = (request: RemoveMembershipRepoRequest) =>
      this.groupMembershipRepo.removeMembershipFromGroup(request)

    const validateRequest = (
      req: RemoveMembersFromGroupRequest
    ): TE.TaskEither<"invalid_uuid", RemoveMembersFromGroupRequest> =>
      isUUID(req.groupId) && req.members.every(m => isUUID(m.userId)) ? TE.right(req) : TE.left("invalid_uuid" as const)

    return pipe(
      request,
      validateRequest,
      TE.map(r => {
        return {
          groupId: r.groupId,
          membershipReferences: r.members.map(member => member.userId)
        }
      }),
      TE.chainW(removeMemberships)
    )
  }
}
