import {
  AddGroupEntitiesRequest,
  Group as GroupApi,
  GroupCreate,
  ListGroupEntities200Response,
  ListGroups200Response,
  RemoveGroupEntitiesRequest
} from "@api"
import {
  createGroupApiToServiceModel,
  generateErrorResponseForAddUserToGroup,
  generateErrorResponseForCreateGroup,
  generateErrorResponseForGetGroup,
  generateErrorResponseForListGroups,
  generateErrorResponseForListUsersInGroup,
  generateErrorResponseForRemoveUserFromGroup,
  mapGroupWithEntitiesCountToApi,
  mapGroupWithMembershipToApi,
  mapListGroupMembersResultToApi,
  mapListGroupsResultToApi
} from "@controllers/groups/groups.mappers"
import {CreateGroupRequest} from "@domain"
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res
} from "@nestjs/common"
import {AddMembersToGroupRequest, GroupMembershipService, GroupService, RemoveMembersFromGroupRequest} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"

export const GROUPS_ENDPOINT_ROOT = "groups"

@Controller(GROUPS_ENDPOINT_ROOT)
export class GroupsController {
  constructor(
    private readonly groupService: GroupService,
    private readonly groupMembershipService: GroupMembershipService
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createGroup(@Body() request: GroupCreate, @Res({passthrough: true}) response: Response): Promise<void> {
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
    const serviceGetGroup = (id: string) => this.groupService.getGroupByIdentifier(id)
    const eitherGroup = await pipe(groupIdentifier, TE.right, TE.chainW(serviceGetGroup))()
    if (isLeft(eitherGroup))
      throw generateErrorResponseForGetGroup(eitherGroup.left, `Failed to get group ${groupIdentifier}`)
    return mapGroupWithEntitiesCountToApi(eitherGroup.right)
  }

  @Get(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async listUsersInGroup(
    @Param("groupId") groupId: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number
  ): Promise<ListGroupEntities200Response> {
    const serviceListUsers = (gId: string) => this.groupMembershipService.getGroupByIdentifierWithMembership(gId)

    const eitherResult = await pipe(
      groupId,
      TE.right,
      TE.chainW(serviceListUsers),
      TE.map(data => mapListGroupMembersResultToApi(page, limit, data))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForListUsersInGroup(eitherResult.left, `Failed to list members for group ${groupId}`)

    return eitherResult.right
  }

  @Post(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async addGroupEntities(
    @Param("groupId") groupId: string,
    @Body() request: AddGroupEntitiesRequest
  ): Promise<GroupApi> {
    const addUserRequests: AddMembersToGroupRequest = {
      groupId,
      members: request.entities.map(entity => ({
        userId: entity.entity.entityId,
        role: entity.role
      }))
    }

    const serviceAddMembers = (request: AddMembersToGroupRequest) =>
      this.groupMembershipService.addMembersToGroup(request)

    const eitherResult = await pipe(
      addUserRequests,
      TE.right,
      TE.chainW(serviceAddMembers),
      TE.map(mapGroupWithMembershipToApi)
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForAddUserToGroup(eitherResult.left, `Failed to add members to group ${groupId}`)
    }

    return eitherResult.right
  }

  @Delete(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async removeEntitiesFromGroup(
    @Param("groupId") groupId: string,
    @Body() request: RemoveGroupEntitiesRequest
  ): Promise<GroupApi> {
    const removeUserRequests: RemoveMembersFromGroupRequest = {
      groupId,
      members: request.entities.map(entity => ({
        userId: entity.entity.entityId
      }))
    }

    const serviceRemoveUser = (request: RemoveMembersFromGroupRequest) =>
      this.groupMembershipService.removeEntitiesFromGroup(request)

    const eitherResult = await pipe(
      removeUserRequests,
      TE.right,
      TE.chainW(serviceRemoveUser),
      TE.map(mapGroupWithMembershipToApi)
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForRemoveUserFromGroup(
        eitherResult.left,
        `Failed to remove entities from group ${groupId}`
      )
    }

    return eitherResult.right
  }
}
