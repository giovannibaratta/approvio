import {
  Space,
  SpaceFactory,
  User,
  UserFactory,
  SystemRole,
  RolePermissionChecker,
  SpaceValidationError,
  UserValidationError,
  RoleValidationError
} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {UserRepository, USER_REPOSITORY_TOKEN} from "@services/user/interfaces"
import {Versioned} from "@domain"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
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
export type GetSpaceError = GetSpaceRepoError | AuthorizationError
export type ListSpacesError = ListSpacesRepoError | AuthorizationError
export type DeleteSpaceError = DeleteSpaceRepoError | AuthorizationError

export const SPACE_MAX_LIMIT = 100

@Injectable()
export class SpaceService {
  constructor(
    @Inject(SPACE_REPOSITORY_TOKEN)
    private readonly spaceRepo: SpaceRepository,
    @Inject(USER_REPOSITORY_TOKEN)
    private readonly userRepo: UserRepository
  ) {}

  /**
   * Creates a new space and grants the creator manage permissions atomically.
   * Only users (not agents/systems) can create spaces.
   */
  createSpace(request: CreateSpaceRequest): TaskEither<CreateSpaceError, Space> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const validateSpace = (req: CreateSpaceRequest) => pipe(req.spaceData, SpaceFactory.newSpace, TE.fromEither)

    const fetchUser = (requestor: User) => this.userRepo.getUserById(requestor.id)

    const addManagePermissions = ({user, space}: {user: Versioned<User>; space: Space}) => {
      const manageRole = SystemRole.createSpaceManagerRole({type: "space", spaceId: space.id})
      return pipe(UserFactory.addPermissions(user, [manageRole]), TE.fromEither)
    }

    const persistSpaceWithUserPermissions = (data: {space: Space; updatedUser: User; userOcc: bigint}) =>
      this.spaceRepo.createSpaceWithUserPermissions({
        space: data.space,
        user: data.updatedUser,
        userOcc: data.userOcc
      })

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("space", () => validateSpace(request)),
      TE.bindW("user", ({requestor}) => fetchUser(requestor)),
      TE.bindW("updatedUser", ({user, space}) => addManagePermissions({user, space})),
      TE.chainW(({space, updatedUser, user}) =>
        persistSpaceWithUserPermissions({space, updatedUser, userOcc: user.occ})
      )
    )
  }

  /**
   * Retrieves a space by ID. Requires read permission on the space OR org admin status.
   */
  getSpace(request: GetSpaceRequest): TaskEither<GetSpaceError, Versioned<Space>> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const checkPermissions = (requestor: User, spaceId: string): TaskEither<GetSpaceError, string> => {
      const isOrgAdmin = requestor.orgRole === "admin"
      const hasReadPermission = RolePermissionChecker.hasSpacePermission(
        requestor.roles,
        {type: "space", spaceId},
        "read"
      )

      if (isOrgAdmin || hasReadPermission) return TE.right(spaceId)
      return TE.left("requestor_not_authorized" as AuthorizationError)
    }

    const fetchSpaceData = (spaceId: string): TaskEither<GetSpaceError, Versioned<Space>> => {
      return this.spaceRepo.getSpaceById({spaceId})
    }

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("authorizedSpaceId", ({requestor}) => checkPermissions(requestor, request.spaceId)),
      TE.chainW(({authorizedSpaceId}) => fetchSpaceData(authorizedSpaceId))
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

    return pipe(
      validateUserEntity(request.requestor),
      TE.fromEither,
      TE.chainW(() => this.spaceRepo.listSpaces({page, limit}))
    )
  }

  /**
   * Deletes a space. Requires manage permission on the space OR org admin status.
   */
  deleteSpace(request: DeleteSpaceRequest): TaskEither<DeleteSpaceError, void> {
    const validateRequestor = () => TE.fromEither(validateUserEntity(request.requestor))

    const checkPermissions = (requestor: User, spaceId: string): TaskEither<DeleteSpaceError, string> => {
      const isOrgAdmin = requestor.orgRole === "admin"
      const hasManagePermission = RolePermissionChecker.hasSpacePermission(
        requestor.roles,
        {type: "space", spaceId},
        "manage"
      )

      if (isOrgAdmin || hasManagePermission) return TE.right(spaceId)
      return TE.left("requestor_not_authorized" as AuthorizationError)
    }

    const deleteSpaceData = (spaceId: string): TaskEither<DeleteSpaceError, void> => {
      return this.spaceRepo.deleteSpace({spaceId})
    }

    return pipe(
      TE.Do,
      TE.bindW("requestor", () => validateRequestor()),
      TE.bindW("authorizedSpaceId", ({requestor}) => checkPermissions(requestor, request.spaceId)),
      TE.chainW(({authorizedSpaceId}) => deleteSpaceData(authorizedSpaceId))
    )
  }
}
