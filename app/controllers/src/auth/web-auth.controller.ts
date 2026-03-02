import {
  Controller,
  Get,
  Post,
  Res,
  Logger,
  Query,
  Body,
  HttpCode,
  BadRequestException,
  InternalServerErrorException,
  Req
} from "@nestjs/common"
import {Response, Request} from "express"
import {AuthService, TokenPair} from "@services"
import {ConfigProvider} from "@external/config"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity} from "../../../main/src/auth"
import {AuthenticatedEntity} from "@domain"
import {generateErrorPayload} from "@controllers/error"
import {logSuccess} from "@utils"
import {HttpStatusCode} from "axios"
import {
  validateWebCallbackRequest,
  validateWebRefreshTokenRequest,
  validateExchangeWebPrivilegeTokenRequest
} from "./web-auth.validators"
import {mapWebCallbackErrorToCode} from "./web-auth.mappers"
import {
  generateErrorResponseForExchangePrivilegeToken,
  generateErrorResponseForRefreshUserToken,
  mapToPrivilegeTokenExchange
} from "./auth.mappers"

@Controller("auth/web")
export class WebAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configProvider: ConfigProvider
  ) {}

  @PublicRoute()
  @HttpCode(HttpStatusCode.Found)
  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    const result = await pipe(
      this.authService.initiateOidcLogin(),
      logSuccess("OIDC login initiated", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Failed to initiate OIDC login", result.left)
      throw new InternalServerErrorException(
        generateErrorPayload("OIDC_INITIATION_FAILED", "Failed to initiate OIDC login")
      )
    }

    Logger.debug(`Redirecting to OIDC provider: ${result.right}`)
    res.redirect(result.right)
  }

  @PublicRoute()
  @Get("callback")
  async webCallback(@Query() query: unknown, @Res() res: Response): Promise<void> {
    const result = await pipe(
      TE.fromEither(validateWebCallbackRequest(query)),
      TE.chainW(({code, state}) => this.authService.completeOidcLogin(code, state)),
      logSuccess("Web Token generated", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Web OIDC login completion failed", result.left)
      const errorCode = mapWebCallbackErrorToCode(result.left)
      res.redirect(`${this.configProvider.frontendUrl}/login?error=${errorCode}`)
      return
    }

    this.setAuthCookies(res, result.right)
    res.redirect(this.configProvider.frontendUrl)
  }

  @PublicRoute()
  @Post("refresh")
  @HttpCode(204)
  async refreshUserTokenWeb(@Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await pipe(
      TE.fromEither(validateWebRefreshTokenRequest(req.cookies)),
      TE.chainW(refreshToken => this.authService.refreshTokenForUser(refreshToken)),
      logSuccess("Web User token refreshed", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Web User token refresh failed", result.left)
      res.clearCookie("access_token")
      res.clearCookie("refresh_token")
      throw generateErrorResponseForRefreshUserToken(result.left, "Failed to refresh token")
    }

    this.setAuthCookies(res, result.right)
    res.send()
  }

  @Post("initiatePrivilegedTokenExchange")
  @HttpCode(200)
  async initiatePrivilegeTokenWeb(): Promise<{authorizationUrl: string}> {
    const result = await pipe(
      this.authService.initiatePrivilegeTokenGeneration(),
      logSuccess("Web Privilege token initiation started", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Failed to initiate web privilege token generation", result.left)
      throw new BadRequestException(generateErrorPayload("INITIATION_FAILED", "Failed to initiate privilege token"))
    }

    return {authorizationUrl: result.right}
  }

  @Post("exchangePrivilegedToken")
  @HttpCode(204)
  async exchangePrivilegeTokenWeb(
    @Body() body: unknown,
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity,
    @Res() res: Response
  ): Promise<void> {
    const result = await pipe(
      TE.right(body),
      TE.chainEitherKW(validateExchangeWebPrivilegeTokenRequest),
      TE.chainEitherKW(mapToPrivilegeTokenExchange),
      TE.chainW(mappedRequest => this.authService.exchangePrivilegeToken(mappedRequest, requestor)),
      logSuccess("Web Privilege token exchanged", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Web Privilege token exchange failed", result.left)
      throw generateErrorResponseForExchangePrivilegeToken(result.left, "Failed to exchange privilege token")
    }

    const secure = this.configProvider.cookieSecure

    // ADR-001: Set a single-use privilege token cookie with maximum CSRF protection.
    res.cookie("privilege_token", result.right.token, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      maxAge: result.right.expiresInSec * 1000
    })

    res.send()
  }

  /**
   * Configures and sets authentication cookies according to ADR-001 (Token Mediated Backend).
   *
   * Security constraints implemented:
   * - httpOnly: true - Prevents XSS-based token exfiltration by making cookies inaccessible to JavaScript.
   * - secure: dynamic - Ensures cookies are only sent over HTTPS (controlled by ConfigProvider).
   * - sameSite: "lax" (Access Token) - Provides CSRF protection for cross-origin navigation while allowing the token on top-level GETs.
   * - sameSite: "strict" (Refresh Token) - Maximum CSRF protection, only sent on same-origin requests.
   * - path: "/" (Access Token) - Available across the entire API surface.
   * - path: "/auth/web/refresh" (Refresh Token) - Strictly scoped to the refresh endpoint to minimize exposure.
   * - maxAge: dynamic - Uses expiration times provided by AuthService/OIDC provider.
   *
   * @param res The Express response object.
   * @param tokenPair The access and refresh token pair with expiration metadata.
   * @private
   */
  private setAuthCookies(res: Response, tokenPair: TokenPair): void {
    const secure = this.configProvider.cookieSecure
    res.cookie("access_token", tokenPair.accessToken, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: tokenPair.accessTokenExpiresInSec * 1000
    })
    res.cookie("refresh_token", tokenPair.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/auth/web/refresh",
      maxAge: tokenPair.refreshTokenExpiresInSec * 1000
    })
  }
}
