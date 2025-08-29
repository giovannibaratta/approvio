import {Pagination as PaginationApi, User as UserApi, UserCreate, UserSummary as UserSummaryApi} from "@approvio/api"
import {GetAuthenticatedEntity} from "@app/auth"
import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res} from "@nestjs/common"
import {AuthenticatedEntity, ListUsersRequest, UserService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createUserApiToServiceModel,
  generateErrorResponseForCreateUser,
  generateErrorResponseForGetUser,
  generateErrorResponseForListUsers,
  mapToServiceRequest,
  mapUserToApi,
  mapUsersToApi
} from "./users.mappers"

export const USERS_ENDPOINT_ROOT = "users"

@Controller(USERS_ENDPOINT_ROOT)
export class UsersController {
  constructor(private readonly userService: UserService) {}

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
      TE.map(data => data.id)
    )()

    if (isLeft(eitherUserId)) {
      throw generateErrorResponseForCreateUser(eitherUserId.left, "Failed to create user")
    }

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
}
