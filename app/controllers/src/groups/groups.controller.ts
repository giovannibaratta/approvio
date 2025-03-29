import {Group as GroupApi, GroupCreate, ListGroups200Response} from "@api"
import {
  createGroupApiToServiceModel,
  generateErrorResponseForCreateGroup,
  generateErrorResponseForGetGroup,
  generateErrorResponseForListGroups,
  mapGroupToApi,
  mapListGroupsResultToApi
} from "@controllers/groups/groups.mappers"
import {CreateGroupRequest} from "@domain"
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res
} from "@nestjs/common"
import {GroupService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"

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

  @Get()
  @HttpCode(HttpStatus.OK)
  async listGroups(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number
  ): Promise<ListGroups200Response> {
    // Wrap in a lambda to preserve the "this" context
    const serviceListGroups = (p: number, l: number) => this.groupService.listGroups(p, l)

    const eitherGroups = await pipe(
      {page, limit},
      TE.right,
      TE.chainW(query => serviceListGroups(query.page, query.limit))
    )()

    if (isLeft(eitherGroups)) throw generateErrorResponseForListGroups(eitherGroups.left, "Failed to list groups")

    return mapListGroupsResultToApi(eitherGroups.right)
  }

  @Get(":groupIdentifier")
  @HttpCode(HttpStatus.OK)
  async getGroup(@Param("groupIdentifier") groupIdentifier: string): Promise<GroupApi> {
    // Wrap in a lambda to preserve the "this" context
    const serviceGetGroup = (id: string) => this.groupService.getGroupByIdentifier(id)

    const eitherGroup = await pipe(groupIdentifier, TE.right, TE.chainW(serviceGetGroup))()

    if (isLeft(eitherGroup))
      throw generateErrorResponseForGetGroup(eitherGroup.left, `Failed to get group ${groupIdentifier}`)

    return mapGroupToApi(eitherGroup.right)
  }
}
