import {
  Space,
  SpaceFactory,
  User,
  OrgRole,
  UserFactory,
  SystemRole,
  RolePermissionChecker,
  SpaceValidationError,
  UserValidationError,
  RoleValidationError,
  AuditLogFactory,
  AuditLogValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {QuotaService} from "@services/quota/quota.service"
import {Versioned} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {logSuccess} from "@utils"
import {
  CreateSpaceRepoError,
  CreateSpaceRequest,
  DeleteSpaceRepoError,
  DeleteSpaceRequest,
  GetSpaceRepoError,
  GetSpaceRequest,
  ListSpacesRepoError,
  ListSpacesRequest,
  ListSpacesResult,
  SpaceRepository,
  SPACE_REPOSITORY_TOKEN
} from "./interfaces"
import {validateUserEntity} from "@services/shared/types"
import {extractActorDetails} from "@services/shared/actor-extractor"
import {TransactionManager, TRANSACTION_MANAGER_TOKEN, ExecutionError} from "@services/transaction/interfaces"
import {AuditLogRepository, AUDIT_LOG_REPOSITORY_TOKEN} from "@services/audit-log/interfaces"

export type CreateSpaceError =
  | CreateSpaceRepoError
  | SpaceValidationError
  | UserValidationError
  | RoleValidationError
  | AuthorizationError
  | "user_not_found"
  | "user_not_found_in_db"
  | "user_invalid_uuid"
  | "request_invalid_user_identifier"
  | AuditLogValidationError
  | ExecutionError

export type GetSpaceError = GetSpaceRepoError | AuthorizationError | ExecutionError
export type ListSpacesError = ListSpacesRepoError | AuthorizationError | ExecutionError
export type DeleteSpaceError = DeleteSpaceRepoError | AuthorizationError | AuditLogValidationError | ExecutionError

export const SPACE_MAX_LIMIT = 100

@Injectable()
export class SpaceService {
  constructor(
    @Inject(SPACE_REPOSITORY_TOKEN)
    private readonly spaceRepo: SpaceRepository,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository,
    private readonly quotaService: QuotaService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly txManager: TransactionManager,
    @Inject(AUDIT_LOG_REPOSITORY_TOKEN)
    private readonly auditLogRepo: AuditLogRepository
  ) {}

  /**
   * Creates a new space and grants the creator manage permissions atomically.
   * Only users (not agents/systems) can create spaces.
   */
  createSpace(request: CreateSpaceRequest): TaskEither<CreateSpaceError, Space> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const validateSpace = (req: CreateSpaceRequest) => pipe(req.spaceData, s => SpaceFactory.newSpace(s), TE.fromEither)

    const fetchUser = (requestor: User): TaskEither<CreateSpaceError, Versioned<User>> =>
      this.userRepo.getUserById(request, requestor.id)

    const addManagePermissions = ({user, space}: {user: Versioned<User>; space: Space}) => {
      const manageRole = SystemRole.createSpaceManagerRole({
        type: "space",
        spaceId: space.id,
        organizationId: request.organizationId
      })
      return pipe(UserFactory.addPermissions(user, [manageRole]), TE.fromEither)
    }

    const persistSpaceWithUserPermissions = (data: {space: Space; updatedUser: User; userOcc: bigint}) =>
      this.spaceRepo.createSpaceWithUserPermissions(request, {
        space: data.space,
        user: data.updatedUser,
        userOcc: data.userOcc
      })

    const checkQuota = () =>
      pipe(
        this.quotaService.isQuotaAvailable({type: "Org", identifier: request.organizationId}, "MAX_SPACES", 1, request),
        TE.mapLeft(() => "quota_check_error" as const),
        TE.chainW(isAvailable => (isAvailable ? TE.right(undefined) : TE.left("quota_exceeded" as const)))
      )

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.chainFirstW(() => checkQuota()),
      TE.bindW("actor", () => TE.right(extractActorDetails(request.requestor))),
      TE.bindW("space", () => validateSpace(request)),
      TE.bindW("user", ({requestor}) => fetchUser(requestor)),
      TE.bindW("updatedUser", ({user, space}) => addManagePermissions({user, space})),
      TE.chainW(({space, updatedUser, user, actor}) =>
        this.txManager.execute(request, () =>
          pipe(
            persistSpaceWithUserPermissions({space, updatedUser, userOcc: user.occ}),
            TE.chainFirstW(createdSpace => {
              return pipe(
                AuditLogFactory.create({
                  auditType: "SPACE_CREATED",
                  entityType: "SPACE",
                  organizationId: request.organizationId,
                  entityId: createdSpace.id,
                  actor: actor,
                  payload: {
                    name: createdSpace.name,
                    description: createdSpace.description ?? null
                  }
                }),
                TE.fromEither,
                TE.chainW(log => this.auditLogRepo.persist(request, log))
              )
            })
          )
        )
      ),
      logSuccess("Space created", "SpaceService", space => ({id: space.id, name: space.name}))
    )
  }

  /**
   * Retrieves a space by ID. Requires read permission on the space OR org admin status.
   */
  getSpace(request: GetSpaceRequest): TaskEither<GetSpaceError, Versioned<Space>> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const checkPermissions = (requestor: User, spaceId: string): TaskEither<GetSpaceError, string> => {
      const isOrgAdmin = requestor.orgRole === OrgRole.ADMIN
      const hasReadPermission = RolePermissionChecker.hasSpacePermission(
        requestor.roles,
        {type: "space", spaceId, organizationId: request.organizationId},
        "read"
      )

      if (isOrgAdmin || hasReadPermission) return TE.right(spaceId)
      return TE.left("requestor_not_authorized")
    }

    const fetchSpaceData = (spaceId: string): TaskEither<GetSpaceError, Versioned<Space>> => {
      return this.spaceRepo.getSpaceById(request, {spaceId})
    }

    return this.txManager.execute<GetSpaceError, Versioned<Space>>(request, () =>
      pipe(
        TE.Do,
        TE.bindW("requestor", () => validateRequestor()),
        TE.bindW("authorizedSpaceId", ({requestor}) => checkPermissions(requestor, request.spaceId)),
        TE.chainW(({authorizedSpaceId}) => fetchSpaceData(authorizedSpaceId)),
        logSuccess("Space retrieved", "SpaceService", space => ({id: space.id}))
      )
    )
  }

  /**
   * Lists all spaces with pagination.
   * NOTE: This is a temporary backdoor - everyone can list all spaces.
   * In the future, list and get operations may return different levels of information.
   * This allows discovery of spaces for collaboration while get operation provides detailed access.
   */
  listSpaces(request: ListSpacesRequest): TaskEither<ListSpacesError, ListSpacesResult> {
    const page = request.page ?? 1
    let limit = request.limit ?? 20

    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = SPACE_MAX_LIMIT

    return this.txManager.execute<ListSpacesError, ListSpacesResult>(request, () =>
      pipe(
        validateUserEntity(request.requestor),
        TE.fromEither,
        TE.chainW(() => this.spaceRepo.listSpaces(request, {page, limit, search: request.search})),
        logSuccess("Spaces listed", "SpaceService", result => ({
          count: result.spaces.length,
          total: result.total
        }))
      )
    )
  }

  /**
   * Deletes a space. Requires manage permission on the space OR org admin status.
   */
  deleteSpace(request: DeleteSpaceRequest): TaskEither<DeleteSpaceError, void> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const checkPermissions = (requestor: User, spaceId: string): TaskEither<DeleteSpaceError, string> => {
      const isOrgAdmin = requestor.orgRole === OrgRole.ADMIN
      const hasManagePermission = RolePermissionChecker.hasSpacePermission(
        requestor.roles,
        {type: "space", spaceId, organizationId: request.organizationId},
        "manage"
      )

      if (isOrgAdmin || hasManagePermission) return TE.right(spaceId)
      return TE.left("requestor_not_authorized")
    }

    const actorDetails = extractActorDetails(request.requestor)

    const deleteSpaceData = (spaceId: string): TaskEither<DeleteSpaceError, void> => {
      return this.txManager.execute(request, () =>
        pipe(
          this.spaceRepo.deleteSpace(request, {spaceId}),
          TE.chainFirstW(() => {
            return pipe(
              AuditLogFactory.create({
                auditType: "SPACE_DELETED",
                entityType: "SPACE",
                organizationId: request.organizationId,
                entityId: spaceId,
                actor: actorDetails,
                payload: {}
              }),
              TE.fromEither,
              TE.chainW(auditLog => this.auditLogRepo.persist(request, auditLog))
            )
          })
        )
      )
    }

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("authorizedSpaceId", ({requestor}) => checkPermissions(requestor, request.spaceId)),
      TE.chainW(({authorizedSpaceId}) => deleteSpaceData(authorizedSpaceId)),
      logSuccess("Space deleted", "SpaceService", () => ({spaceId: request.spaceId}))
    )
  }
}
