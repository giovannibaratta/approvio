import {
  Group,
  GroupManager,
  Membership,
  MembershipFactory,
  UserValidationError,
  createUserMembershipEntity,
  createAgentMembershipEntity,
  EntityReference,
  AgentValidationError,
  AuditLogFactory,
  CreateAuditLog,
  AuditLogValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError, UnknownError} from "@services"
import {User, OrgRole} from "@domain"
import {GetGroupRepoError} from "@services/group/interfaces"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"
import {Versioned} from "@domain"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {AgentRepository, AGENT_REPOSITORY_TOKEN} from "@services/agent/interfaces"
import {QuotaService} from "@services/quota/quota.service"
import {isUUIDv7, logSuccess, DistributiveOmit} from "@utils"
import * as A from "fp-ts/Array"
import {pipe} from "fp-ts/function"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {TransactionManager, TRANSACTION_MANAGER_TOKEN, ExecutionError} from "@services/transaction/interfaces"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "@services/audit-log/interfaces"
import {extractActorDetails} from "@services/shared/actor-extractor"
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
    private readonly agentRepo: AgentRepository,
    private readonly quotaService: QuotaService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly txManager: TransactionManager,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
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
    | AuthorizationError
    | ExecutionError,
    GetGroupMembershipResult
  > {
    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (data: GetGroupWithMembershipRepo) => this.groupMembershipRepo.getGroupWithMembershipById(data)

    const validateRequest = (
      req: GetGroupWithMembershipRequest
    ): TE.TaskEither<"request_invalid_group_uuid", GetGroupWithMembershipRequest> => {
      if (!isUUIDv7(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      return TE.right(req)
    }

    const prepareRepoData = (req: GetGroupWithMembershipRequest, requestor: User): GetGroupWithMembershipRepo => {
      const onlyIfMember = requestor.orgRole === OrgRole.ADMIN ? false : {userId: requestor.id}

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
    | "request_invalid_group_uuid"
    | "request_invalid_entity_uuid"
    | MembershipAddError
    | AuthorizationError
    | AuditLogValidationError
    | ExecutionError,
    GetGroupMembershipResult
  > {
    const validateRequest = (
      req: AddMembersToGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_entity_uuid", AddMembersToGroupRequest> => {
      if (!isUUIDv7(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv7(m.entityId))) return TE.left("request_invalid_entity_uuid")
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

      const initialCount = groupManager.getMemberships().length

      // Check if any member to add is already in the group
      for (const membership of membershipsToAdd) {
        const addResult = groupManager.addMembership(membership)
        if (isLeft(addResult)) return TE.left(addResult.left)
      }

      const newCount = groupManager.getMemberships().length

      return TE.right({group: data.group, addedMembershipsCount: newCount - initialCount})
    }

    const persistMemberships = (group: Versioned<Group>, membershipsToAdd: readonly Readonly<Membership>[]) =>
      this.groupMembershipRepo.addMembershipsToGroup({
        group,
        memberships: membershipsToAdd
      })

    const checkQuota = (request: AddMembersToGroupRequest, addedMembershipsCount: number) => {
      return pipe(
        this.quotaService.isQuotaAvailable(
          {type: "Group", identifier: request.groupId},
          "MAX_ENTITIES_PER_GROUP",
          addedMembershipsCount
        ),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )
    }

    return pipe(
      TE.Do,
      TE.bindW("request", () => TE.right(request)),
      TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
      TE.bindW("validatedRequestor", () => TE.fromEither(validateUserEntity(request.requestor))),
      TE.bindW("membershipsToAdd", ({request}) => this.fetchEntitiesAndCreateMemberships(request.members)),
      TE.bindW("groupMembershipData", ({request}) => fetchGroupMembershipData(request)),
      TE.bindW("simulationResult", ({validatedRequestor, groupMembershipData, membershipsToAdd}) =>
        simulateAddMemberships(validatedRequestor, groupMembershipData, membershipsToAdd)
      ),
      TE.chainFirstW(({validatedRequest, simulationResult}) =>
        checkQuota(validatedRequest, simulationResult.addedMembershipsCount)
      ),
      TE.bindW("actor", () => TE.right(extractActorDetails(request.requestor))),
      TE.chainW(({simulationResult, membershipsToAdd, actor}) =>
        this.txManager.execute(() =>
          pipe(
            persistMemberships(simulationResult.group, membershipsToAdd),
            TE.chainFirstW(() =>
              this.persistGroupMembershipAuditLog({
                auditType: "MEMBERSHIPS_ADDED",
                entityType: "GROUP",
                entityId: request.groupId,
                actor: actor,
                payload: {
                  members: request.members.map(m => ({entityId: m.entityId, entityType: m.entityType}))
                }
              })
            )
          )
        )
      ),
      logSuccess("Members added to group", "GroupMembershipService", () => ({groupId: request.groupId}))
    )
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<
    | "request_invalid_group_uuid"
    | "request_invalid_entity_uuid"
    | MembershipRemoveError
    | AuthorizationError
    | AuditLogValidationError
    | ExecutionError,
    GetGroupMembershipResult
  > {
    const validateRequest = (
      req: RemoveMembersFromGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_entity_uuid", RemoveMembersFromGroupRequest> => {
      if (!isUUIDv7(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv7(m.entityId))) return TE.left("request_invalid_entity_uuid")
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
      TE.bindW("simulatedRemove", ({validatedRequestor, membershipData}) =>
        simulateRemoveMemberships(validatedRequestor, membershipData)
      ),
      TE.bindW("actor", () => TE.right(extractActorDetails(request.requestor))),
      TE.chainW(({actor, membershipData}) =>
        this.txManager.execute(() =>
          pipe(
            removeMemberships(membershipData),
            TE.chainFirstW(() =>
              this.persistGroupMembershipAuditLog({
                auditType: "MEMBERSHIPS_REMOVED",
                entityType: "GROUP",
                entityId: request.groupId,
                actor: actor,
                payload: {
                  members: request.members.map(m => ({entityId: m.entityId, entityType: m.entityType}))
                }
              })
            )
          )
        )
      ),
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

  private persistGroupMembershipAuditLog(
    data: DistributiveOmit<CreateAuditLog, "createdAt">
  ): TaskEither<AuditLogValidationError | UnknownError, void> {
    return pipe(
      AuditLogFactory.create(data),
      TE.fromEither,
      TE.chainW(validAuditLog => this.auditLogRepo.persist(validAuditLog))
    )
  }
}

export interface GetGroupWithMembershipRequest extends RequestorAwareRequest {
  groupId: string
}
