import {RolePermissionChecker, OrgRole, getEntityRoles, User, UnconstrainedBoundRole} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {SpaceRepository, SPACE_REPOSITORY_TOKEN} from "@services/space/interfaces"
import {GroupRepository, GROUP_REPOSITORY_TOKEN} from "@services/group/interfaces"
import {
  ResolveResourcesError,
  ResolveResourcesRequest,
  ResourceDeniedItem,
  ResourceResolvedItem,
  ResourceResolveResponse
} from "./interfaces"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {validateUserEntity} from "@services/shared/types"
import {Either, left, right, isLeft} from "fp-ts/Either"

@Injectable()
export class ResourcesService {
  constructor(
    @Inject(SPACE_REPOSITORY_TOKEN) private readonly spaceRepo: SpaceRepository,
    @Inject(GROUP_REPOSITORY_TOKEN) private readonly groupRepo: GroupRepository
  ) {}

  resolveResources(request: ResolveResourcesRequest): TaskEither<ResolveResourcesError, ResourceResolveResponse> {
    const {requestor, request: payload} = request

    const processResources = (user: User): TaskEither<ResolveResourcesError, ResourceResolveResponse> => {
      const isOrgAdmin = user.orgRole === OrgRole.ADMIN
      const roles = getEntityRoles(requestor)

      const {spaceIds, groupIds} = extractResourceIds(payload.resources)

      return pipe(
        TE.sequenceArray([
          spaceIds.length > 0 ? this.spaceRepo.getSpacesByIds(spaceIds) : TE.right([]),
          groupIds.length > 0 ? this.groupRepo.getGroupsByIds(groupIds) : TE.right([])
        ]),
        TE.chainW(res => {
          if (res.length !== 2) return TE.left("unknown_error" as const)
          const [spaces, groups] = res
          if (spaces === undefined || groups === undefined) return TE.left("unknown_error" as const)
          return TE.right(categorizeResources(payload.resources, spaces, groups, isOrgAdmin, roles))
        })
      )
    }

    return pipe(TE.fromEither(validateUserEntity(requestor)), TE.chainW(processResources))
  }
}

function extractResourceIds(resources: ReadonlyArray<{type: "space" | "group"; id: string}>) {
  const spaceIds: string[] = []
  const groupIds: string[] = []

  for (const r of resources)
    if (r.type === "space") spaceIds.push(r.id)
    else if (r.type === "group") groupIds.push(r.id)

  return {spaceIds, groupIds}
}

/**
 * Categorizes a list of resource requests into resolved (accessible) and denied (inaccessible or not found) resources.
 * For each resource request, it checks whether it is a "space" or a "group", resolves its access/existence, and classifies it.
 *
 * @param resources - A read-only array of resource references containing the type (space/group) and ID.
 * @param spaces - An array of fetched spaces containing their IDs and names.
 * @param groups - An array of fetched groups containing their IDs and names.
 * @param isOrgAdmin - A flag indicating if the requesting user is an organization administrator (grants full access).
 * @param roles - The unconstrained bound roles of the requesting user to evaluate permissions against.
 * @returns An object containing the list of resolved and denied items.
 */
function categorizeResources(
  resources: ReadonlyArray<{type: "space" | "group"; id: string}>,
  spaces: {id: string; name: string}[],
  groups: {id: string; name: string}[],
  isOrgAdmin: boolean,
  roles: ReadonlyArray<UnconstrainedBoundRole>
): ResourceResolveResponse {
  const spaceMap = new Map(spaces.map(s => [s.id, s]))
  const groupMap = new Map(groups.map(g => [g.id, g]))

  const resolved: ResourceResolvedItem[] = []
  const denied: ResourceDeniedItem[] = []

  for (const resourceReq of resources)
    if (resourceReq.type === "space") {
      const res = resolveSpace(resourceReq, spaceMap, isOrgAdmin, roles)
      if (isLeft(res)) denied.push(res.left)
      else resolved.push(res.right)
    } else if (resourceReq.type === "group") {
      const res = resolveGroup(resourceReq, groupMap, isOrgAdmin, roles)
      if (isLeft(res)) denied.push(res.left)
      else resolved.push(res.right)
    }

  return {resolved, denied}
}

/**
 * Resolves access to a specific space.
 * Checks if the space exists, and if the requestor has "read" permission for it (either via organization administrator status or bound roles).
 *
 * @param resourceReq - The resource request containing the space ID.
 * @param spaceMap - A map of fetched spaces indexed by their ID.
 * @param isOrgAdmin - A flag indicating if the requesting user is an organization administrator.
 * @param roles - The unconstrained bound roles of the requesting user.
 * @returns An `Either` containing a `ResourceDeniedItem` if the space was not found or not authorized, or a `ResourceResolvedItem` if access is granted.
 */
function resolveSpace(
  resourceReq: {id: string},
  spaceMap: Map<string, {id: string; name: string}>,
  isOrgAdmin: boolean,
  roles: ReadonlyArray<UnconstrainedBoundRole>
): Either<ResourceDeniedItem, ResourceResolvedItem> {
  const space = spaceMap.get(resourceReq.id)
  if (!space) return left({type: "space", id: resourceReq.id, reason: "NOT_FOUND"})

  const hasAccess =
    isOrgAdmin || RolePermissionChecker.hasSpacePermission(roles, {type: "space", spaceId: space.id}, "read")

  if (hasAccess) return right({type: "space", id: space.id, name: space.name})
  return left({type: "space", id: space.id, reason: "NOT_AUTHORIZED"})
}

/**
 * Resolves access to a specific group.
 * Checks if the group exists, and if the requestor has "read" permission for it (either via organization administrator status or bound roles).
 *
 * @param resourceReq - The resource request containing the group ID.
 * @param groupMap - A map of fetched groups indexed by their ID.
 * @param isOrgAdmin - A flag indicating if the requesting user is an organization administrator.
 * @param roles - The unconstrained bound roles of the requesting user.
 * @returns An `Either` containing a `ResourceDeniedItem` if the group was not found or not authorized, or a `ResourceResolvedItem` if access is granted.
 */
function resolveGroup(
  resourceReq: {id: string},
  groupMap: Map<string, {id: string; name: string}>,
  isOrgAdmin: boolean,
  roles: ReadonlyArray<UnconstrainedBoundRole>
): Either<ResourceDeniedItem, ResourceResolvedItem> {
  const group = groupMap.get(resourceReq.id)
  if (!group) return left({type: "group", id: resourceReq.id, reason: "NOT_FOUND"})

  const hasAccess =
    isOrgAdmin || RolePermissionChecker.hasGroupPermission(roles, {type: "group", groupId: group.id}, "read")

  if (hasAccess) return right({type: "group", id: group.id, name: group.name})
  return left({type: "group", id: group.id, reason: "NOT_AUTHORIZED"})
}
