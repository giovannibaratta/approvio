import {Inject, Injectable} from "@nestjs/common"
import {CreateGroupRequest, GroupFactory, GroupValidationError} from "@domain"
import {Group} from "@domain"
import {TaskEither} from "fp-ts/TaskEither"
import {GROUP_REPOSITORY_TOKEN, GroupCreateError, GroupRepository} from "./interfaces"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"

export type CreateGroupError = GroupValidationError | GroupCreateError

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
}
