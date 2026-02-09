import {
  Group,
  GroupManager,
  Membership,
  MembershipFactory,
  UserValidationError,
  createUserMembershipEntity,
  createAgentMembershipEntity,
  EntityReference,
  AgentValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services"
import {User} from "@domain"
import {GetGroupRepoError} from "@services/group/interfaces"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"
import {Versioned} from "@domain"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {AgentRepository, AGENT_REPOSITORY_TOKEN} from "@services/agent/interfaces"
import {isUUIDv4, logSuccess} from "@utils"
import * as A from "fp-ts/Array"
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
import {AgentKeyDecodeError} from "@services/agent/interfaces"

export interface AddMembersToGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<EntityReference>
}

export interface RemoveMembersFromGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<EntityReference>
}

@Injectable()
export class GroupMembershipService {
  constructor(
    @Inject(GROUP_MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly groupMembershipRepo: GroupMembershipRepository,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository,
    @Inject(AGENT_REPOSITORY_TOKEN)
    private readonly agentRepo: AgentRepository
  ) {}

  getGroupByIdentifierWithMembership(
    request: GetGroupWithMembershipRequest
  ): TaskEither<
    | "request_invalid_group_uuid"
    | GetGroupRepoError
    | UserValidationError
    | "membership_invalid_entity_uuid"
    | "membership_inconsistent_dates"
    | AgentKeyDecodeError
    | AgentValidationError
    | AuthorizationError,
    GetGroupMembershipResult
  > {
    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (data: GetGroupWithMembershipRepo) => this.groupMembershipRepo.getGroupWithMembershipById(data)

    const validateRequest = (
      req: GetGroupWithMembershipRequest
    ): TE.TaskEither<"request_invalid_group_uuid", GetGroupWithMembershipRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      return TE.right(req)
    }

    const prepareRepoData = (req: GetGroupWithMembershipRequest, requestor: User): GetGroupWithMembershipRepo => {
      const onlyIfMember = requestor.orgRole === "admin" ? false : {userId: requestor.id}

      return {
        groupId: req.groupId,
        onlyIfMember
      }
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("validatedRequestor", ({request}) => TE.fromEither(validateUserEntity(request.requestor))),
      TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
      TE.map(({validatedRequest, validatedRequestor}) => prepareRepoData(validatedRequest, validatedRequestor)),
      TE.chainW(repoGetGroup)
    )
  }

  addMembersToGroup(
    request: AddMembersToGroupRequest
  ): TaskEither<
    "request_invalid_group_uuid" | "request_invalid_entity_uuid" | MembershipAddError | AuthorizationError,
    GetGroupMembershipResult
  > {
    const validateRequest = (
      req: AddMembersToGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_entity_uuid", AddMembersToGroupRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv4(m.entityId))) return TE.left("request_invalid_entity_uuid")
      return TE.right(req)
    }

    const fetchGroupMembershipData = (r: AddMembersToGroupRequest) =>
      this.getGroupByIdentifierWithMembership({groupId: r.groupId, requestor: r.requestor})

    const simulateAddMemberships = (
      requestor: User,
      data: GetGroupMembershipResult,
      membershipsToAdd: readonly Readonly<Membership>[]
    ) => {
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

    const persistMemberships = (group: Versioned<Group>, membershipsToAdd: readonly Readonly<Membership>[]) =>
      this.groupMembershipRepo.addMembershipsToGroup({
        group,
        memberships: membershipsToAdd
      })

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
      TE.bindW("validatedRequestor", () => TE.fromEither(validateUserEntity(request.requestor))),
      TE.bindW("membershipsToAdd", ({request}) => this.fetchEntitiesAndCreateMemberships(request.members)),
      TE.bindW("groupMembershipData", ({request}) => fetchGroupMembershipData(request)),
      TE.bindW("group", ({validatedRequestor, groupMembershipData, membershipsToAdd}) =>
        simulateAddMemberships(validatedRequestor, groupMembershipData, membershipsToAdd)
      ),
      TE.chainW(({group, membershipsToAdd}) => persistMemberships(group, membershipsToAdd)),
      logSuccess("Members added to group", "GroupMembershipService", () => ({groupId: request.groupId}))
    )
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<
    "request_invalid_group_uuid" | "request_invalid_entity_uuid" | MembershipRemoveError | AuthorizationError,
    GetGroupMembershipResult
  > {
    const validateRequest = (
      req: RemoveMembersFromGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_entity_uuid", RemoveMembersFromGroupRequest> => {
      if (!isUUIDv4(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv4(m.entityId))) return TE.left("request_invalid_entity_uuid")
      return TE.right(req)
    }

    const fetchGroupMembershipData = pipe(
      request,
      validateRequest,
      TE.chainW(r => this.getGroupByIdentifierWithMembership({groupId: r.groupId, requestor: r.requestor}))
    )

    const simulateRemoveMemberships = (requestor: User, data: GetGroupMembershipResult) => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)

      if (isLeft(groupManagerEither)) return TE.left(groupManagerEither.left)

      const groupManager = groupManagerEither.right

      if (!groupManager.canRemoveMembership(requestor)) return TE.left("requestor_not_authorized" as const)

      // Simulate removing each member
      for (const member of request.members) {
        const removeResult = groupManager.removeMembership(member)
        if (isLeft(removeResult)) return TE.left(removeResult.left)
      }

      return TE.right({group: data.group, memberships: data.memberships})
    }

    const removeMemberships = (data: GetGroupMembershipResult) => {
      const removeRequest: RemoveMembershipRepoRequest = {
        groupId: data.group.id,
        entityReferences: request.members
      }
      return this.groupMembershipRepo.removeMembershipFromGroup(removeRequest)
    }

    return pipe(
      TE.Do,
      TE.bindW("validatedRequestor", () => TE.fromEither(validateUserEntity(request.requestor))),
      TE.bindW("membershipData", () => fetchGroupMembershipData),
      TE.chainW(({validatedRequestor, membershipData}) =>
        simulateRemoveMemberships(validatedRequestor, membershipData)
      ),
      TE.chainW(removeMemberships),
      logSuccess("Entities removed from group", "GroupMembershipService", () => ({groupId: request.groupId}))
    )
  }

  private fetchEntitiesAndCreateMemberships(
    members: ReadonlyArray<EntityReference>
  ): TaskEither<MembershipAddError, ReadonlyArray<Membership>> {
    const fetchUserAndCreateMembership = (entityId: string) =>
      pipe(
        this.userRepo.getUserById(entityId),
        TE.map(createUserMembershipEntity),
        TE.chainEitherKW(entity =>
          MembershipFactory.newMembership({
            entity
          })
        )
      )

    const fetchAgentAndCreateMembership = (entityId: string) =>
      pipe(
        this.agentRepo.getAgentById(entityId),
        TE.map(createAgentMembershipEntity),
        TE.chainEitherKW(entity =>
          MembershipFactory.newMembership({
            entity
          })
        )
      )

    return pipe(
      [...members],
      A.traverse(TE.ApplicativeSeq)(member => {
        switch (member.entityType) {
          case "user":
            return fetchUserAndCreateMembership(member.entityId)
          case "agent":
            return fetchAgentAndCreateMembership(member.entityId)
        }
      })
    )
  }
}

export interface GetGroupWithMembershipRequest extends RequestorAwareRequest {
  groupId: string
}
