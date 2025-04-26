import {CreateGroupRequest, Group, GroupFactory, GroupValidationError, GroupWithEntititesCount} from "@domain"
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
import {Versioned} from "@services/shared/utils"
import {isUUID} from "@services/shared/validation"

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

  getGroupByIdentifier(groupIdentifier: string): TaskEither<GetGroupError, Versioned<GroupWithEntititesCount>> {
    const isUuid = isUUID(groupIdentifier)

    // Wrap in a lambda to preserve the "this" context
    const repoGetGroup = (value: string) =>
      isUuid ? this.groupRepo.getGroupById(value) : this.groupRepo.getGroupByName(value)

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
