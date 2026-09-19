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
  Req,
  Headers
} from "@nestjs/common"
import {Response, Request} from "express"
import {AccessToken, AuthService, TokenPair} from "@services"
import {ConfigProvider} from "@external/config"
import {isLeft} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity, GetBrowserSession} from "../../../main/src/auth"
import {AuthenticatedBrowserSession, AuthenticatedEntity} from "@domain"
import {generateErrorPayload} from "@controllers/error"
import {logSuccess} from "@utils"
import {HttpStatusCode} from "axios"
import {
  validateWebCallbackRequest,
  validateWebRefreshTokenRequest,
  validateExchangeWebPrivilegeTokenRequest
} from "./web-auth.validators"
import {
  mapWebCallbackErrorToCode,
  generateErrorResponseForWebSessionContext,
  generateErrorResponseForWebOrganizationSwitch
} from "./web-auth.mappers"
import {WebSessionContext, validateWebOrganizationSwitch} from "@approvio/api"
import {createSessionTag, parseSessionTag} from "../etag"
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
  async login(@Query("provider") provider: string | undefined, @Res() res: Response): Promise<void> {
    const result = await pipe(
      this.authService.initiateOidcLogin("initial_login", provider),
      logSuccess("OIDC login initiated", "WebAuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Failed to initiate OIDC login", result.left)
      if (result.left === "auth_invalid_oidc_provider" || result.left === "auth_missing_oidc_provider")
        throw new BadRequestException(
          generateErrorPayload(result.left.toUpperCase(), `WebAuthController: ${result.left}`)
        )

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

  @Get("session")
  async getSessionContext(
    @GetBrowserSession() principal: AuthenticatedBrowserSession,
    @Res({passthrough: true}) res: Response
  ): Promise<WebSessionContext> {
    const result = await pipe(
      this.authService.getWebSessionContext(principal),
      TE.map(session => {
        res.setHeader(
          "ETag",
          createSessionTag(
            this.configProvider.jwtConfig.secret,
            getBrowserSessionAccountId(principal),
            principal.sessionId,
            session.occ
          )
        )
        return {selectedOrganizationId: session.selectedOrganizationId}
      })
    )()

    if (isLeft(result)) throw generateErrorResponseForWebSessionContext(result.left)

    return result.right
  }

  @Post("organization-context")
  async switchOrganizationContext(
    @GetBrowserSession() principal: AuthenticatedBrowserSession,
    @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({passthrough: true}) res: Response
  ): Promise<WebSessionContext> {
    const result = await pipe(
      validateWebOrganizationSwitch(body),
      TE.fromEither,
      TE.bindTo("request"),
      TE.bindW("expectedOcc", () =>
        TE.fromEither(
          parseSessionTag(
            this.configProvider.jwtConfig.secret,
            getBrowserSessionAccountId(principal),
            principal.sessionId,
            ifMatch
          )
        )
      ),
      TE.chainW(({request, expectedOcc}) =>
        this.authService.switchWebOrganization(principal, request.organizationId, expectedOcc)
      ),
      TE.map(session => {
        // The access token remains account-bound and the selected organization is checked against the
        // current session and route context by the guard; a second organization token is unnecessary.
        this.setAccessTokenCookie(res, session)
        res.setHeader(
          "ETag",
          createSessionTag(
            this.configProvider.jwtConfig.secret,
            getBrowserSessionAccountId(principal),
            principal.sessionId,
            session.occ
          )
        )
        return {selectedOrganizationId: session.selectedOrganizationId}
      }),
      logSuccess("Web organization context switched", "WebAuthController")
    )()

    if (isLeft(result)) throw generateErrorResponseForWebOrganizationSwitch(result.left)

    return result.right
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
      Logger.error(`Web User token refresh failed: ${result.left.toUpperCase()}`, "WebAuthController")
      res.clearCookie("access_token")
      res.clearCookie("refresh_token")
      throw generateErrorResponseForRefreshUserToken(result.left, "Failed to refresh token")
    }

    this.setAuthCookies(res, result.right)
    res.send()
  }

  @Post("initiatePrivilegedTokenExchange")
  @HttpCode(200)
  async initiatePrivilegeTokenWeb(
    @GetAuthenticatedEntity() requestor: AuthenticatedEntity
  ): Promise<{authorizationUrl: string}> {
    const result = await pipe(
      this.authService.initiatePrivilegeTokenGenerationForWeb(requestor),
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

  @PublicRoute()
  @Post("logout")
  @HttpCode(204)
  logout(@Res() res: Response): void {
    res.clearCookie("access_token", {path: "/"})
    res.clearCookie("refresh_token", {path: "/auth/web/refresh"})
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
    this.setAccessTokenCookie(res, tokenPair)
    const secure = this.configProvider.cookieSecure
    res.cookie("refresh_token", tokenPair.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/auth/web/refresh",
      maxAge: tokenPair.refreshTokenExpiresInSec * 1000
    })
  }

  private setAccessTokenCookie(res: Response, token: AccessToken): void {
    res.cookie("access_token", token.accessToken, {
      httpOnly: true,
      secure: this.configProvider.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: token.accessTokenExpiresInSec * 1000
    })
  }
}

function getBrowserSessionAccountId(principal: AuthenticatedBrowserSession): string {
  return principal.entityType === "platform" ? principal.account.id : principal.user.accountId
}
