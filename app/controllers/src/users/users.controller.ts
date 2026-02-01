import {
  Pagination as PaginationApi,
  User as UserApi,
  UserCreate,
  UserSummary as UserSummaryApi,
  RoleAssignmentRequest,
  RoleRemovalRequest
} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, Post, Put, Query, Res} from "@nestjs/common"
import {
  ListUsersRequest,
  UserService,
  RoleService,
  AssignRolesToUserRequest,
  RemoveRolesFromUserRequest
} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createUserApiToServiceModel,
  generateErrorResponseForCreateUser,
  generateErrorResponseForGetUser,
  generateErrorResponseForListUsers,
  generateErrorResponseForUserRoleAssignment,
  generateErrorResponseForUserRoleRemoval,
  mapToServiceRequest,
  mapUserToApi,
  mapUsersToApi
} from "./users.mappers"
import {validateRoleAssignmentRequest, validateRoleRemovalRequest} from "../shared/mappers"
import {AuthenticatedEntity} from "@domain"

export const USERS_ENDPOINT_ROOT = "users"

@Controller(USERS_ENDPOINT_ROOT)
export class UsersController {
  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createUser(
    @Body() request: UserCreate,
    @Res({passthrough: true}) response: Response,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    // Wrap service call in lambda
    const serviceCreateUser = (req: Parameters<UserService["createUser"]>[0]) => this.userService.createUser(req)

    const eitherUserId = await pipe(
      {requestor, userData: request},
      createUserApiToServiceModel,
      TE.fromEither,
      TE.chainW(serviceCreateUser),
      TE.map(data => data.id),
      TE.chainFirstW(userId =>
        TE.fromIO(() => {
          Logger.log(`User created successfully with id ${userId} (${request.email})`)
        })
      )
    )()

    if (isLeft(eitherUserId)) throw generateErrorResponseForCreateUser(eitherUserId.left, "Failed to create user")

    const userId = eitherUserId.right
    const location = `${response.req.protocol}://${response.req.headers.host}${response.req.url}/${userId}`
    response.setHeader("Location", location)
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async listUsers(
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string
  ): Promise<{users: UserSummaryApi[]; pagination: PaginationApi}> {
    const requestToService = (request: ListUsersRequest) => this.userService.listUsers(request)

    const eitherUsers = await pipe(
      {search, page, limit},
      mapToServiceRequest,
      TE.fromEither,
      TE.chainW(requestToService),
      TE.map(mapUsersToApi)
    )()

    if (isLeft(eitherUsers)) throw generateErrorResponseForListUsers(eitherUsers.left, "Failed to list users")

    return eitherUsers.right
  }

  @Get(":userIdentifier")
  @HttpCode(HttpStatus.OK)
  async getUser(@Param("userIdentifier") userIdentifier: string): Promise<UserApi> {
    const eitherUser = await this.userService.getUserByIdentifier(userIdentifier)()

    if (isLeft(eitherUser)) {
      throw generateErrorResponseForGetUser(eitherUser.left, "Failed to get user")
    }

    const user = eitherUser.right
    return mapUserToApi(user)
  }

  @Put(":userId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRolesToUser(
    @Param("userId") userId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const mapToServiceModel = (req: RoleAssignmentRequest) => ({
      userId,
      roles: req.roles,
      requestor
    })
    const assignRole = (req: AssignRolesToUserRequest) => this.roleService.assignRolesToUser(req)

    const eitherResult = await pipe(
      request,
      E.right,
      E.chainW(validateRoleAssignmentRequest),
      E.map(mapToServiceModel),
      TE.fromEither,
      TE.chainW(assignRole)
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForUserRoleAssignment(eitherResult.left, "Failed to assign roles to user")
  }

  @Delete(":userId/roles")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRolesFromUser(
    @Param("userId") userId: string,
    @Body() request: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<void> {
    const mapToServiceModel = (req: RoleRemovalRequest) => ({
      userId,
      roles: req.roles,
      requestor
    })
    const removeRole = (req: RemoveRolesFromUserRequest) => this.roleService.removeRolesFromUser(req)

    const eitherResult = await pipe(
      request,
      E.right,
      E.chainW(validateRoleRemovalRequest),
      E.map(mapToServiceModel),
      TE.fromEither,
      TE.chainW(removeRole)
    )()

    if (isLeft(eitherResult))
      throw generateErrorResponseForUserRoleRemoval(eitherResult.left, "Failed to remove roles from user")
  }
}
