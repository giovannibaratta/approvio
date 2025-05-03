import {Group, GroupFactory, GroupWithEntitiesCount, ListFilterFactory} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {AuthorizationError} from "@services/error"
import {MembershipAddError} from "@services/group-membership"
import {RequestorAwareRequest} from "@services/shared/types"
import {Versioned} from "@services/shared/utils"
import {isUUID} from "@services/shared/validation"
import * as E from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  CreateGroupRepoError,
  CreateGroupWithOwnerRepo,
  GetGroupRepoError,
  GROUP_REPOSITORY_TOKEN,
  GroupRepository,
  ListGroupsRepo,
  ListGroupsRepoError,
  ListGroupsResult
} from "./interfaces"

export type CreateGroupError = CreateGroupRepoError | MembershipAddError
export type GetGroupError = GetGroupRepoError | AuthorizationError
export type ListGroupsError = ListGroupsRepoError | AuthorizationError

export const MAX_LIMIT = 100

@Injectable()
export class GroupService {
  constructor(
    @Inject(GROUP_REPOSITORY_TOKEN)
    private readonly groupRepo: GroupRepository
  ) {}

  createGroup(request: CreateGroupRequest): TaskEither<CreateGroupError, Group> {
    // Wrap in a lambda to preserve the "this" context
    const persistGroup = (data: CreateGroupWithOwnerRepo) => this.groupRepo.createGroupWithOwner(data)
    const validateRequest = (req: CreateGroupRequest) =>
      pipe(
        req.groupData,
        GroupFactory.newGroup,
        E.map(group => {
          return {group, requestor: req.requestor}
        })
      )

    return pipe(request, validateRequest, TE.fromEither, TE.chainW(persistGroup))
  }

  getGroupByIdentifier(
    request: GetGroupByIdentifierRequest
  ): TaskEither<GetGroupError, Versioned<GroupWithEntitiesCount>> {
    const {groupIdentifier, requestor} = request
    const isUuid = isUUID(groupIdentifier)

    const onlyIfMember = requestor.orgRole === "admin" ? false : {userId: requestor.id}

    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (value: string) =>
      isUuid
        ? this.groupRepo.getGroupById({onlyIfMember, groupId: value})
        : this.groupRepo.getGroupByName({onlyIfMember, groupName: value})

    return pipe(groupIdentifier, TE.right, TE.chainW(repoGetGroup))
  }

  listGroups(request: ListGroupsRequest): TaskEither<ListGroupsError, ListGroupsResult> {
    const page = request.page
    let limit = request.limit

    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = MAX_LIMIT

    const repoListGroups = (data: ListGroupsRepo) => this.groupRepo.listGroups(data)

    const buildRepoRequest = (req: ListGroupsRequest) => {
      const filter = ListFilterFactory.generateListFiltersForRequestor(req.requestor)
      return {page, limit, filter}
    }

    return pipe(request, buildRepoRequest, TE.right, TE.chainW(repoListGroups))
  }
}

export interface CreateGroupRequest extends RequestorAwareRequest {
  groupData: Parameters<typeof GroupFactory.newGroup>[0]
}

export interface ListGroupsRequest extends RequestorAwareRequest {
  page: number
  limit: number
}

export interface GetGroupByIdentifierRequest extends RequestorAwareRequest {
  groupIdentifier: string
}
