import {
  AuthenticatedEntity,
  Group,
  GroupFactory,
  GroupWithEntitiesCount,
  ListFilterFactory,
  MembershipFactory,
  MembershipValidationError,
  User,
  OrgRole,
  UserFactory,
  SystemRole,
  UserValidationError,
  createUserMembershipEntity,
  RolePermissionChecker,
  AuditLogFactory,
  CreateAuditLog,
  AuditLogValidationError,
  BoundaryError,
  TenantContext
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError, UnknownError} from "@services/error"
import {RequestorAwareRequest, validateUserEntity} from "@services/shared/types"
import {Versioned} from "@domain"
import {isUUIDv7, logSuccess} from "@utils"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {QuotaService} from "@services/quota/quota.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  TenantTransactionManager,
  TRANSACTION_MANAGER_TOKEN,
  ExecutionError,
  TransactionError
} from "@services/transaction/interfaces"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "@services/audit-log/interfaces"
import {extractActorDetails} from "@services/shared/actor-extractor"
import {inTransaction} from "@services/transaction/in-transaction"
import {
  CreateGroupRepoError,
  CreateGroupWithMembershipAndUpdateUserRepo,
  GetGroupRepoError,
  GROUP_REPOSITORY_TOKEN,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult
} from "./interfaces"

import {TenantOperationError} from "../tenancy/interfaces"

export type CreateGroupError =
  | TenantOperationError
  | CreateGroupRepoError
  | MembershipValidationError
  | UserValidationError
  | AuthorizationError
  | AuditLogValidationError
  | ExecutionError
  | "quota_exceeded"
  | "quota_check_error"
  | "request_invalid_user_identifier"

export type GetGroupError = GetGroupRepoError | AuthorizationError | TransactionError
export type ListGroupsError = ListGroupsRepoError | AuthorizationError | TransactionError

export const MAX_LIMIT = 100

@Injectable()
export class GroupService {
  constructor(
    @Inject(GROUP_REPOSITORY_TOKEN)
    private readonly groupRepo: GroupRepository,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository,
    private readonly quotaService: QuotaService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly txManager: TenantTransactionManager,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
  ) {}

  /**
   * Creates a new group and adds the requesting user as a member with manage permissions.
   * All users are allowed to create groups.
   */
  createGroup(request: CreateGroupRequest): TaskEither<CreateGroupError, Group> {
    const validateRequestor = (current: AuthenticatedEntity) => TE.fromEither(validateUserEntity(current))

    const validateGroup = (req: CreateGroupRequest) => pipe(req.groupData, g => GroupFactory.newGroup(g), TE.fromEither)

    const fetchUser = (requestor: User) => this.userRepo.getUserById(request, requestor.id)

    const createMembership = (user: User) =>
      pipe(MembershipFactory.newMembership({entity: createUserMembershipEntity(user)}), TE.fromEither)

    const addManagePermissions = ({user, group}: {user: Versioned<User>; group: Group}) => {
      const manageRole = SystemRole.createGroupManagerRole({
        type: "group",
        organizationId: group.organizationId,
        groupId: group.id
      })
      return pipe(UserFactory.addPermissions(user, [manageRole]), TE.fromEither)
    }

    const persistGroupWithMembershipAndUpdateUser = (data: CreateGroupWithMembershipAndUpdateUserRepo) =>
      this.groupRepo.createGroupWithMembershipAndUpdateUser(request, data)

    const checkQuota = () =>
      pipe(
        this.quotaService.isQuotaAvailable({type: "Org", identifier: request.organizationId}, "MAX_GROUPS", request, 1),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )

    return pipe(
      this.txManager.execute<CreateGroupError, Group>(request, () =>
        pipe(
          TE.Do,
          TE.bindW("requestor", () => validateRequestor(request.requestor)),
          TE.chainFirstW(() => checkQuota()),
          TE.bindW("group", () => validateGroup(request)),
          TE.bindW("actor", () => TE.right(extractActorDetails(request.requestor))),
          inTransaction(this.txManager, request, ({requestor, group, actor}) =>
            pipe(
              fetchUser(requestor),
              TE.bindTo("user"),
              TE.bindW("updatedUser", ({user}) => addManagePermissions({user, group})),
              TE.bindW("membership", ({updatedUser}) => createMembership(updatedUser)),
              TE.chainW(({updatedUser, user, membership}) =>
                pipe(
                  persistGroupWithMembershipAndUpdateUser({group, user: updatedUser, userOcc: user.occ, membership}),
                  TE.chainFirstW(createdGroup =>
                    this.persistGroupAuditLog(request, {
                      auditType: "GROUP_CREATED",
                      organizationId: request.organizationId,
                      entityType: "GROUP",
                      entityId: createdGroup.id,
                      actor,
                      payload: {
                        name: createdGroup.name,
                        description: createdGroup.description ?? null
                      },
                      createdAt: createdGroup.createdAt
                    })
                  )
                )
              )
            )
          )
        )
      ),
      logSuccess("Group created", "GroupService", group => ({id: group.id, name: group.name}))
    )
  }

  getGroupByIdentifier(
    request: GetGroupByIdentifierRequest
  ): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> {
    const {groupIdentifier} = request
    const isUuid = isUUIDv7(groupIdentifier)

    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const resolveGroupId = (identifier: string): TaskEither<GetGroupError, string> => {
      return isUuid ? TE.right(identifier) : this.groupRepo.getGroupIdByName(request, identifier)
    }

    const checkPermissions = (requestor: User, groupId: string): TaskEither<GetGroupError, string> => {
      const isOrgAdmin = requestor.orgRole === OrgRole.ADMIN
      const hasReadPermission = RolePermissionChecker.hasGroupPermission(
        requestor.roles,
        {type: "group", organizationId: request.organizationId, groupId},
        "read"
      )

      if (isOrgAdmin || hasReadPermission) return TE.right(groupId)
      return TE.left("requestor_not_authorized")
    }

    const fetchGroupData = (groupId: string): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> => {
      return this.groupRepo.getGroupById(request, {groupId})
    }

    return pipe(
      validateRequestor(),
      inTransaction(this.txManager, request, requestor =>
        pipe(
          resolveGroupId(groupIdentifier),
          TE.chainW(groupId =>
            pipe(
              checkPermissions(requestor, groupId),
              TE.chainW(authorizedGroupId => fetchGroupData(authorizedGroupId))
            )
          )
        )
      ),
      logSuccess("Group retrieved", "GroupService", group => ({id: group.id}))
    )
  }

  listGroups(request: ListGroupsRequest): TaskEither<ListGroupsError, ListGroupsResult> {
    const page = request.page
    let limit = request.limit

    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = MAX_LIMIT

    const repoListGroups = (data: ListGroupsRepo) => this.groupRepo.listGroups(request, data)
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const buildRepoRequest = (requestor: User) => {
      const filter = ListFilterFactory.generateListFiltersForRequestor(requestor, request.search)
      return {page, limit, filter}
    }

    return pipe(
      validateRequestor(),
      TE.map(buildRepoRequest),
      inTransaction(this.txManager, request, repoRequest => repoListGroups(repoRequest)),
      logSuccess("Groups listed", "GroupService", result => ({count: result.groups.length, total: result.total}))
    )
  }

  getUserGroups(context: TenantContext, userId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      TE.Do,
      inTransaction(this.txManager, context, () => this.groupRepo.getGroupsByUserId(context, userId))
    )
  }

  getAgentGroups(context: TenantContext, agentId: string): TaskEither<GetGroupRepoError, Group[]> {
    return pipe(
      TE.Do,
      inTransaction(this.txManager, context, () => this.groupRepo.getGroupsByAgentId(context, agentId))
    )
  }

  private persistGroupAuditLog(
    context: RequestorAwareRequest,
    data: CreateAuditLog
  ): TaskEither<AuditLogValidationError | BoundaryError | UnknownError, void> {
    return pipe(
      AuditLogFactory.create(data),
      TE.fromEither,
      TE.chainW(validAuditLog => this.auditLogRepo.persist(context, validAuditLog))
    )
  }
}

export interface CreateGroupRequest extends RequestorAwareRequest {
  groupData: Parameters<typeof GroupFactory.newGroup>[0]
}

export interface ListGroupsRequest extends RequestorAwareRequest {
  page: number
  limit: number
  search?: string
}

export interface GetGroupByIdentifierRequest extends RequestorAwareRequest {
  groupIdentifier: string
}
