import {PublicRoute} from "@app/auth"
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post
} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {UserService} from "@services"
import {DebugService} from "@services/debug"
import {isLeft} from "fp-ts/Either"
import {pipe} from "fp-ts/lib/function"
import * as TE from "fp-ts/lib/TaskEither"
import {generateErrorPayload} from "../error"

export const DEBUG_ENDPOINT_ROOT = "debug"

@Controller(DEBUG_ENDPOINT_ROOT)
export class DebugController {
  constructor(
    private readonly userService: UserService,
    private readonly debugService: DebugService,
    private readonly jwtService: JwtService
  ) {}

  @PublicRoute()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() request: DebugLoginRequest): Promise<DebugLoginResponse> {
    if (!request.email || request.email.trim().length === 0)
      throw new BadRequestException(generateErrorPayload("INVALID_REQUEST", "Email cannot be empty"))

    // Fetch an existing user or create a new one
    const userEither = await this.userService.getUserByIdentifier(request.email)()

    let userDomain
    if (isLeft(userEither)) {
      if (userEither.left !== "user_not_found")
        throw new InternalServerErrorException(
          generateErrorPayload(userEither.left.toUpperCase(), `Failed to retrieve user: ${userEither.left}`)
        )

      const createUser = (email: string) => this.debugService.createDebugUser(email)
      const newUserEither = await pipe(request.email, TE.right, TE.chainW(createUser))()

      if (isLeft(newUserEither))
        throw new InternalServerErrorException(
          generateErrorPayload(newUserEither.left.toUpperCase(), `Failed to create debug user: ${newUserEither.left}`)
        )
      userDomain = newUserEither.right
    } else userDomain = userEither.right

    // Generate JWT token
    const payload = {email: userDomain.email, sub: userDomain.id}
    const token = this.jwtService.sign(payload)

    return {token}
  }
}

export interface DebugLoginRequest {
  email: string
}

export interface DebugLoginResponse {
  token: string
}
