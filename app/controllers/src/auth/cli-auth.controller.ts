import {Controller, Get, Post, Res, Logger, Body, HttpCode} from "@nestjs/common"
import {Response} from "express"
import {AuthService} from "@services"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity} from "../../../main/src/auth"
import {AuthenticatedEntity} from "@domain"
import {TokenResponse, PrivilegedTokenResponse} from "@approvio/api"
import {
  validateInitiateCliLoginRequest,
  validateGenerateCliTokenRequest,
  validateRefreshCliTokenRequest,
  validateExchangeCliPrivilegeTokenRequest
} from "./cli-auth.validators"
import {
  generateErrorResponseForCliInitiate,
  generateErrorResponseForCliGenerateToken,
  generateErrorResponseForCliRefreshUserToken,
  generateErrorResponseForCliExchangePrivilegeToken
} from "./cli-auth.mappers"
import {mapToTokenResponse, mapToPrivilegeTokenExchange} from "./auth.mappers"
import {logSuccess} from "@utils"
import {HttpStatusCode} from "axios"

@Controller("auth/cli")
export class CliAuthController {
  constructor(private readonly authService: AuthService) {}

  @PublicRoute()
  @Post("initiate")
  @HttpCode(200)
  async initiateCliLogin(@Body() body: unknown): Promise<{authorizationUrl: string}> {
    const result = await pipe(
      TE.fromEither(validateInitiateCliLoginRequest(body)),
      TE.chainW(({redirectUri}) => this.authService.initiateOidcLoginFromCli(redirectUri)),
      logSuccess("CLI OIDC login initiated", "CliAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Failed to initiate CLI OIDC login", result.left)
      throw generateErrorResponseForCliInitiate(result.left, "CliAuthController")
    }

    return {authorizationUrl: result.right}
  }

  @PublicRoute()
  @Post("token")
  async generateToken(@Body() body: unknown): Promise<TokenResponse> {
    const result = await pipe(
      TE.fromEither(validateGenerateCliTokenRequest(body)),
      TE.chainW(({code, state}) => this.authService.completeOidcLogin(code, state)),
      TE.map(mapToTokenResponse),
      logSuccess("Token generated", "CliAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("OIDC login completion failed", result.left)
      throw generateErrorResponseForCliGenerateToken(result.left, "CliAuthController")
    }

    return result.right
  }

  @PublicRoute()
  @Post("refresh")
  @HttpCode(200)
  async refreshUserToken(@Body() body: unknown): Promise<TokenResponse> {
    const result = await pipe(
      TE.fromEither(validateRefreshCliTokenRequest(body)),
      TE.chainW(({refreshToken}) => this.authService.refreshTokenForUser(refreshToken)),
      TE.map(mapToTokenResponse),
      logSuccess("User token refreshed", "CliAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("User token refresh failed", result.left)
      throw generateErrorResponseForCliRefreshUserToken(result.left, "CliAuthController")
    }

    return result.right
  }

  @PublicRoute()
  @HttpCode(HttpStatusCode.Found)
  @Get("initiatePrivilegedTokenExchange")
  async initiatePrivilegeToken(@Res() res: Response): Promise<void> {
    const runInitiation = () => this.authService.initiatePrivilegeTokenGeneration()

    const result = await pipe(runInitiation(), logSuccess("Privilege token initiation started", "CliAuthController"))()

    if (isLeft(result)) {
      Logger.error("Failed to initiate privilege token generation", result.left)
      res.redirect("/auth/error")
      return
    }

    Logger.debug(`Redirecting to IDP for step-up: ${result.right}`)
    res.redirect(result.right)
  }

  @Post("exchangePrivilegedToken")
  @HttpCode(200)
  async exchangePrivilegeToken(
    @Body() body: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<PrivilegedTokenResponse> {
    const result = await pipe(
      TE.fromEither(validateExchangeCliPrivilegeTokenRequest(body)),
      TE.chainEitherKW(mapToPrivilegeTokenExchange),
      TE.chainW(mappedRequest => this.authService.exchangePrivilegeToken(mappedRequest, requestor)),
      TE.map(privilegedToken => ({accessToken: privilegedToken.token})),
      logSuccess("Privilege token exchanged", "CliAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Privilege token exchange failed", result.left)
      throw generateErrorResponseForCliExchangePrivilegeToken(result.left, "CliAuthController")
    }

    return result.right
  }
}
