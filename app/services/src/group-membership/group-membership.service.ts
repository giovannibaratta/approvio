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
  AuditLogValidationError,
  BoundaryError
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
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {TenantTransactionManager, TRANSACTION_MANAGER_TOKEN, ExecutionError} from "@services/transaction/interfaces"
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
import {TenantOperationError} from "../tenancy/interfaces"

export interface AddMembersToGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<GroupMemberReference>
}

export interface RemoveMembersFromGroupRequest extends RequestorAwareRequest {
  groupId: string
  members: ReadonlyArray<GroupMemberReference>
}

type GroupMemberReference = Pick<EntityReference, "entityId" | "entityType">

type GetGroupWithMembershipError =
  | "request_invalid_group_uuid"
  | GetGroupRepoError
  | UserValidationError
  | "membership_invalid_entity_uuid"
  | "membership_inconsistent_dates"
  | AgentKeyDecodeError
  | AgentValidationError
  | "membership_invalid_organization_id"
  | "membership_organization_mismatch"
  | AuthorizationError
  | ExecutionError

type AddMembersToGroupError =
  | TenantOperationError
  | "request_invalid_group_uuid"
  | "request_invalid_entity_uuid"
  | MembershipAddError
  | AuthorizationError
  | AuditLogValidationError
  | ExecutionError

type RemoveEntitiesFromGroupError =
  | TenantOperationError
  | "request_invalid_group_uuid"
  | "request_invalid_entity_uuid"
  | MembershipRemoveError
  | AuthorizationError
  | AuditLogValidationError
  | ExecutionError

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
    private readonly txManager: TenantTransactionManager,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
  ) {}

  getGroupByIdentifierWithMembership(
    request: GetGroupWithMembershipRequest
  ): TaskEither<GetGroupWithMembershipError, GetGroupMembershipResult> {
    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (data: GetGroupWithMembershipRepo) =>
      this.groupMembershipRepo.getGroupWithMembershipById(request, data)

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

    return this.txManager.execute<GetGroupWithMembershipError, GetGroupMembershipResult>(request, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("validatedRequestor", ({request}) => TE.fromEither(validateUserEntity(request.requestor))),
        TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
        TE.map(({validatedRequest, validatedRequestor}) => prepareRepoData(validatedRequest, validatedRequestor)),
        TE.chainW(repoGetGroup)
      )
    )
  }

  addMembersToGroup(request: AddMembersToGroupRequest): TaskEither<AddMembersToGroupError, GetGroupMembershipResult> {
    const validateRequest = (
      req: AddMembersToGroupRequest
    ): TE.TaskEither<"request_invalid_group_uuid" | "request_invalid_entity_uuid", AddMembersToGroupRequest> => {
      if (!isUUIDv7(req.groupId)) return TE.left("request_invalid_group_uuid" as const)
      if (req.members.some(m => !isUUIDv7(m.entityId))) return TE.left("request_invalid_entity_uuid")
      return TE.right(req)
    }

    const fetchGroupMembershipData = (r: AddMembersToGroupRequest) =>
      this.getGroupByIdentifierWithMembership({
        organizationId: r.organizationId,
        groupId: r.groupId,
        requestor: r.requestor
      })

    const simulateAddMemberships = (
      requestor: User,
      data: GetGroupMembershipResult,
      membershipsToAdd: readonly Readonly<Membership>[]
    ): E.Either<MembershipAddError | AuthorizationError, {group: Versioned<Group>; addedMembershipsCount: number}> => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)
      if (E.isLeft(groupManagerEither)) return groupManagerEither

      const groupManager = groupManagerEither.right
      if (!groupManager.canUpdateMembership(requestor)) return E.left("requestor_not_authorized")

      const initialCount = groupManager.getMemberships().length

      // Check if any member to add is already in the group
      for (const membership of membershipsToAdd) {
        const addResult = groupManager.addMembership(membership)
        if (E.isLeft(addResult)) return addResult
      }

      const newCount = groupManager.getMemberships().length
      return E.right({group: data.group, addedMembershipsCount: newCount - initialCount})
    }

    const persistMemberships = (group: Versioned<Group>, membershipsToAdd: readonly Readonly<Membership>[]) =>
      this.groupMembershipRepo.addMembershipsToGroup(request, {
        group,
        memberships: membershipsToAdd
      })

    const checkQuota = (request: AddMembersToGroupRequest, addedMembershipsCount: number) => {
      return pipe(
        this.quotaService.isQuotaAvailable(
          {type: "Group", identifier: request.groupId},
          "MAX_ENTITIES_PER_GROUP",
          request,
          addedMembershipsCount
        ),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )
    }

    return this.txManager.execute<AddMembersToGroupError, GetGroupMembershipResult>(request, () =>
      pipe(
        TE.Do,
        TE.bindW("request", () => TE.right(request)),
        TE.bindW("validatedRequest", ({request}) => validateRequest(request)),
        TE.bindW("validatedRequestor", ({request}) => TE.fromEither(validateUserEntity(request.requestor))),
        TE.bindW("membershipsToAdd", ({request}) => this.fetchEntitiesAndCreateMemberships(request, request.members)),
        TE.bindW("groupMembershipData", ({request}) => fetchGroupMembershipData(request)),
        TE.bindW("simulationResult", ({validatedRequestor, groupMembershipData, membershipsToAdd}) =>
          TE.fromEither(simulateAddMemberships(validatedRequestor, groupMembershipData, membershipsToAdd))
        ),
        TE.chainFirstW(({validatedRequest, simulationResult}) =>
          checkQuota(validatedRequest, simulationResult.addedMembershipsCount)
        ),
        TE.bindW("actor", ({request}) => TE.right(extractActorDetails(request.requestor))),
        TE.chainW(({simulationResult, membershipsToAdd, actor}) =>
          pipe(
            persistMemberships(simulationResult.group, membershipsToAdd),
            TE.chainFirstW(() =>
              this.persistGroupMembershipAuditLog(request, {
                auditType: "MEMBERSHIPS_ADDED",
                entityType: "GROUP",
                organizationId: request.organizationId,
                entityId: request.groupId,
                actor: actor,
                payload: {
                  members: request.members.map(m => ({...m, organizationId: request.organizationId}))
                }
              })
            )
          )
        ),
        logSuccess("Members added to group", "GroupMembershipService", () => ({groupId: request.groupId}))
      )
    )
  }

  removeEntitiesFromGroup(
    request: RemoveMembersFromGroupRequest
  ): TaskEither<RemoveEntitiesFromGroupError, GetGroupMembershipResult> {
    const memberReferences: ReadonlyArray<EntityReference> = request.members.map(member => ({
      ...member,
      organizationId: request.organizationId
    }))

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
      TE.chainW(r =>
        this.getGroupByIdentifierWithMembership({
          organizationId: r.organizationId,
          groupId: r.groupId,
          requestor: r.requestor
        })
      )
    )

    const simulateRemoveMemberships = (
      requestor: User,
      data: GetGroupMembershipResult
    ): E.Either<MembershipRemoveError | AuthorizationError, GetGroupMembershipResult> => {
      const groupManagerEither = GroupManager.createGroupManager(data.group, data.memberships)
      if (E.isLeft(groupManagerEither)) return groupManagerEither

      const groupManager = groupManagerEither.right
      if (!groupManager.canRemoveMembership(requestor)) return E.left("requestor_not_authorized")

      // Simulate removing each member
      for (const member of memberReferences) {
        const removeResult = groupManager.removeMembership(member)
        if (E.isLeft(removeResult)) return removeResult
      }

      return E.right({group: data.group, memberships: data.memberships})
    }

    const removeMemberships = (data: GetGroupMembershipResult) => {
      const removeRequest: RemoveMembershipRepoRequest = {
        groupId: data.group.id,
        entityReferences: memberReferences
      }
      return this.groupMembershipRepo.removeMembershipFromGroup(request, removeRequest)
    }

    return this.txManager.execute<RemoveEntitiesFromGroupError, GetGroupMembershipResult>(request, () =>
      pipe(
        TE.Do,
        TE.bindW("validatedRequestor", () => TE.fromEither(validateUserEntity(request.requestor))),
        TE.bindW("membershipData", () => fetchGroupMembershipData),
        TE.bindW("simulatedRemove", ({validatedRequestor, membershipData}) =>
          TE.fromEither(simulateRemoveMemberships(validatedRequestor, membershipData))
        ),
        TE.bindW("actor", () => TE.right(extractActorDetails(request.requestor))),
        TE.chainW(({actor, membershipData}) =>
          pipe(
            removeMemberships(membershipData),
            TE.chainFirstW(() =>
              this.persistGroupMembershipAuditLog(request, {
                auditType: "MEMBERSHIPS_REMOVED",
                entityType: "GROUP",
                organizationId: request.organizationId,
                entityId: request.groupId,
                actor: actor,
                payload: {
                  members: [...memberReferences]
                }
              })
            )
          )
        ),
        logSuccess("Entities removed from group", "GroupMembershipService", () => ({groupId: request.groupId}))
      )
    )
  }

  private fetchEntitiesAndCreateMemberships(
    context: RequestorAwareRequest,
    members: ReadonlyArray<GroupMemberReference>
  ): TaskEither<MembershipAddError, ReadonlyArray<Membership>> {
    const fetchUserAndCreateMembership = (entityId: string) =>
      pipe(
        this.userRepo.getUserById(context, entityId),
        TE.map(createUserMembershipEntity),
        TE.chainEitherKW(entity =>
          MembershipFactory.newMembership({
            entity
          })
        )
      )

    const fetchAgentAndCreateMembership = (entityId: string) =>
      pipe(
        this.agentRepo.getAgentById(context, entityId),
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
    context: RequestorAwareRequest,
    data: DistributiveOmit<CreateAuditLog, "createdAt">
  ): TaskEither<AuditLogValidationError | UnknownError | BoundaryError, void> {
    return pipe(
      AuditLogFactory.create(data),
      TE.fromEither,
      TE.chainW(validAuditLog => this.auditLogRepo.persist(context, validAuditLog))
    )
  }
}

export interface GetGroupWithMembershipRequest extends RequestorAwareRequest {
  groupId: string
}
