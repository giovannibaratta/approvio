import {CreateGroupRequest, Group, GroupFactory, GroupValidationError} from "@domain"
import {Inject, Injectable} from "@nestjs/common"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {
  GROUP_REPOSITORY_TOKEN,
  GroupRepository,
  ListGroupsResult,
  GroupCreateError as RepoCreateError,
  GroupGetError as RepoGetError,
  GroupListError as RepoListError
} from "./interfaces"

export type CreateGroupError = GroupValidationError | RepoCreateError
export type GetGroupError = RepoGetError
export type ListGroupsError = RepoListError

const MAX_LIMIT = 100

@Injectable()
export class GroupService {
  constructor(
    @Inject(GROUP_REPOSITORY_TOKEN)
    private readonly groupRepo: GroupRepository
  ) {}

  createGroup(request: CreateGroupRequest): TaskEither<CreateGroupError, Group> {
    // Wrap in a lambda to preserve the "this" context
    const persistGroup = (group: Group) => this.groupRepo.createGroup(group)

    return pipe(request, GroupFactory.newGroup, TE.fromEither, TE.chainW(persistGroup))
  }

  getGroupByIdentifier(groupIdentifier: string): TaskEither<GetGroupError, Group> {
    const isUuid = groupIdentifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (value: string) =>
      isUuid !== null ? this.groupRepo.getGroupById(value) : this.groupRepo.getGroupByName(value)

    return pipe(groupIdentifier, TE.right, TE.chainW(repoGetGroup))
  }

  listGroups(page: number, limit: number): TaskEither<ListGroupsError, ListGroupsResult> {
    if (page <= 0) return TE.left("invalid_page")
    if (limit <= 0) return TE.left("invalid_limit")
    if (limit > 100) limit = MAX_LIMIT

    const repoListGroups = (p: number, l: number) => this.groupRepo.listGroups(p, l)

    return pipe(
      {page, limit},
      TE.right,
      TE.chainW(query => repoListGroups(query.page, query.limit))
    )
  }
}
