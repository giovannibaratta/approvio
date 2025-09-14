import {
  AddGroupEntitiesRequest,
  Group as GroupApi,
  GroupCreate,
  ListGroupEntities200Response,
  ListGroups200Response,
  RemoveGroupEntitiesRequest
} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {
  createGroupApiToServiceModel,
  generateErrorResponseForAddMembersToGroup,
  generateErrorResponseForCreateGroup,
  generateErrorResponseForGetGroup,
  generateErrorResponseForListGroups,
  generateErrorResponseForListMembersInGroup,
  generateErrorResponseForRemoveMembersFromGroup,
  mapGroupWithEntitiesCountToApi,
  mapGroupWithMembershipToApi,
  mapListGroupMembersResultToApi,
  mapListGroupsResultToApi
} from "@controllers/groups/groups.mappers"
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
import {
  AddMembersToGroupRequest,
  CreateGroupRequest,
  GetGroupByIdentifierRequest,
  GetGroupWithMembershipRequest,
  GroupMembershipService,
  GroupService,
  ListGroupsRequest,
  RemoveMembersFromGroupRequest
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {AuthenticatedEntity} from "@domain"

export const GROUPS_ENDPOINT_ROOT = "groups"
const MAX_LIMIT = 100

@Controller(GROUPS_ENDPOINT_ROOT)
export class GroupsController {
  constructor(
    private readonly groupService: GroupService,
    private readonly groupMembershipService: GroupMembershipService
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createGroup(
    @Body() request: GroupCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // Wrap service call in lambda, passing the creatorId
    const serviceCreateGroup = (req: CreateGroupRequest) => this.groupService.createGroup(req)

    const eitherGroup = await pipe(
      {request, requestor},
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
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<ListGroups200Response> {
    // Wrap in a lambda to preserve the "this" context
    const serviceListGroups = (request: ListGroupsRequest) => this.groupService.listGroups(request)
    const eitherGroups = await pipe({page, limit, requestor}, TE.right, TE.chainW(serviceListGroups))()
    if (isLeft(eitherGroups)) throw generateErrorResponseForListGroups(eitherGroups.left, "Failed to list groups")
    return mapListGroupsResultToApi(eitherGroups.right)
  }

  @Get(":groupIdentifier")
  @HttpCode(HttpStatus.OK)
  async getGroup(
    @Param("groupIdentifier") groupIdentifier: string,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<GroupApi> {
    const serviceGetGroup = (request: GetGroupByIdentifierRequest) => this.groupService.getGroupByIdentifier(request)
    const eitherGroup = await pipe({groupIdentifier, requestor}, TE.right, TE.chainW(serviceGetGroup))()
    if (isLeft(eitherGroup))
      throw generateErrorResponseForGetGroup(eitherGroup.left, `Failed to get group ${groupIdentifier}`)
    return mapGroupWithEntitiesCountToApi(eitherGroup.right)
  }

  @Get(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async listMembersInGroup(
    @Param("groupId") groupId: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<ListGroupEntities200Response> {
    // This should be moved to the service layer once the pagination will be implemented
    if (page <= 0)
      throw generateErrorResponseForListMembersInGroup("invalid_page", `Failed to list members for group ${groupId}`)
    if (limit <= 0)
      throw generateErrorResponseForListMembersInGroup("invalid_limit", `Failed to list members for group ${groupId}`)
    if (limit > 100) limit = MAX_LIMIT

    const serviceListUsers = (request: GetGroupWithMembershipRequest) =>
      this.groupMembershipService.getGroupByIdentifierWithMembership(request)

    const eitherResult = await pipe(
      {groupId, requestor},
      TE.right,
      TE.chainW(serviceListUsers),
      TE.map(data => mapListGroupMembersResultToApi(page, limit, data))
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForListMembersInGroup(eitherResult.left, `Failed to list members for group ${groupId}`)

    return eitherResult.right
  }

  @Post(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async addGroupEntities(
    @Param("groupId") groupId: string,
    @Body() request: AddGroupEntitiesRequest,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<GroupApi> {
    const addUserRequests: AddMembersToGroupRequest = {
      groupId,
      members: request.entities.map(entity => ({
        entityId: entity.entity.entityId,
        entityType: entity.entity.entityType === "human" ? "user" : "agent"
      })),
      requestor
    }

    const serviceAddMembers = (req: AddMembersToGroupRequest) => this.groupMembershipService.addMembersToGroup(req)

    const eitherResult = await pipe(
      addUserRequests,
      TE.right,
      TE.chainW(serviceAddMembers),
      TE.map(mapGroupWithMembershipToApi)
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForAddMembersToGroup(eitherResult.left, `Failed to add members to group ${groupId}`)
    }

    return eitherResult.right
  }

  @Delete(":groupId/entities")
  @HttpCode(HttpStatus.OK)
  async removeEntitiesFromGroup(
    @Param("groupId") groupId: string,
    @Body() request: RemoveGroupEntitiesRequest,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<GroupApi> {
    const removeMembersRequest: RemoveMembersFromGroupRequest = {
      groupId,
      members: request.entities.map(entity => ({
        entityId: entity.entity.entityId,
        entityType: entity.entity.entityType === "human" ? "user" : "agent"
      })),
      requestor
    }

    const serviceRemoveMembers = (req: RemoveMembersFromGroupRequest) =>
      this.groupMembershipService.removeEntitiesFromGroup(req)

    const eitherResult = await pipe(
      removeMembersRequest,
      TE.right,
      TE.chainW(serviceRemoveMembers),
      TE.map(mapGroupWithMembershipToApi)
    )()

    if (isLeft(eitherResult)) {
      throw generateErrorResponseForRemoveMembersFromGroup(
        eitherResult.left,
        `Failed to remove entities from group ${groupId}`
      )
    }

    return eitherResult.right
  }
}
