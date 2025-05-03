import {User as UserApi, UserCreate} from "@api"
import {GetAuthenticatedUser} from "@app/auth"
import {User} from "@domain"
import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res} from "@nestjs/common"
import {UserService} from "@services"
import {Response} from "express"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {
  createUserApiToServiceModel,
  generateErrorResponseForCreateUser,
  generateErrorResponseForGetUser,
  mapUserToApi
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
    @GetAuthenticatedUser() requestor: User
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
