import {Controller, Post, Body, HttpCode, Res, HttpStatus} from "@nestjs/common"
import {GroupService} from "@services"
import {GroupCreate} from "@api"
import {createGroupApiToServiceModel, generateErrorResponseForCreateGroup} from "@controllers/groups/groups.mappers"
import {pipe} from "fp-ts/lib/function"
import {isLeft} from "fp-ts/Either"
import {Response} from "express"
import * as TE from "fp-ts/lib/TaskEither"
import {CreateGroupRequest} from "@domain"

export const GROUPS_ENDPOINT_ROOT = "groups"

@Controller(GROUPS_ENDPOINT_ROOT)
export class GroupsController {
  constructor(private readonly groupService: GroupService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createGroup(@Body() request: GroupCreate, @Res({passthrough: true}) response: Response): Promise<void> {
    // Wrap in a lambda to preserve the "this" context
    const serviceCreateGroup = (req: CreateGroupRequest) => this.groupService.createGroup(req)

    const eitherGroup = await pipe(
      request,
      createGroupApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateGroup)
    )()

    if (isLeft(eitherGroup)) throw generateErrorResponseForCreateGroup(eitherGroup.left, "Failed to create group")

    const group = eitherGroup.right
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${group.id}`
    response.setHeader("Location", location)
  }
}
