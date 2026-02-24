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
  Headers,
  Req
} from "@nestjs/common"
import {Response, Request} from "express"
import {AuthService, GenerateChallengeRequest, IdentityService} from "@services"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity} from "../../../main/src/auth"
import {
  TokenRequest,
  TokenResponse,
  SuccessfulAuthResponse,
  FailedAuthResponse,
  AgentChallengeRequest,
  AgentChallengeResponse,
  AgentTokenResponse,
  RefreshTokenRequest,
  AgentTokenRequest,
  GetUserInfo200Response,
  PrivilegedTokenResponse
} from "@approvio/api"
import {
  mapAgentChallengeRequestToService,
  mapChallengeToApiResponse,
  mapTokenToApiResponse,
  generateErrorResponseForChallengeRequest,
  generateErrorResponseForAgentTokenExchange,
  validateAgentTokenRequest,
  validateAgentChallengeRequest
} from "./agent-auth.mappers"
import {pipe} from "fp-ts/lib/function"
import {AuthenticatedEntity} from "@domain"
import {generateErrorPayload} from "@controllers/error"
import {
  validateGenerateTokenRequest,
  validateRefreshAgentTokenRequest,
  validateRefreshTokenRequest,
  validateExchangePrivilegeTokenRequest
} from "./auth.validators"
import {
  generateErrorResponseForGenerateToken,
  generateErrorResponseForRefreshAgentToken,
  generateErrorResponseForRefreshUserToken,
  generateErrorResponseForEntityInfo,
  mapToTokenResponse,
  mapToEntityInfoResponse,
  generateErrorResponseForExchangePrivilegeToken,
  mapToPrivilegeTokenExchange
} from "./auth.mappers"
import {logSuccess} from "@utils"
import {HttpStatusCode} from "axios"

/**
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │                         OIDC Authentication HTTP Endpoints Flow                         │
 * │                              (Load Balancer Compatible)                                 │
 * ├─────────────────────────────────────────────────────────────────────────────────────────┤
 * │                                                                                         │
 * │  Frontend      Load Balancer      Backend A/B       OIDC Provider      Database         │
 * │     │               │                 │                  │                │             │
 * │ 1. GET /auth/login                                                                      │
 * │     │ ──────────────┼────────────────►│ Generate PKCE    │                │             │
 * │     │               │                 │ challenge        │                │             │
 * │     │               │                 │ + Auth URL       │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Store PKCE ──────┼───────────────►│ Session     │
 * │     │               │                 │ {state, codeV}   │                │ Storage     │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to OIDC       │                 │ OIDC Provider    │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 2. User Authentication                                                                  │
 * │     │ ──────────────────────────────────────────────────►│ User login     │             │
 * │     │               │                 │                  │ & consent      │             │
 * │     │               │                 │                  │                │             │
 * │ 3. GET /auth/callback?code=abc&state=xyz                                                │
 * │     │ ◄──────────────────────────────────────────────────┤ Authorization  │             │
 * │     │               │                 │                  │ code callback  │             │
 * │     │               │                 │                  │                │             │
 * │     │ ──────────────┼────────────────►│ Any server can   │                │             │
 * │     │               │                 │ handle callback  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to success    │                 │ /success?code=.. │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 4. POST /auth/token {code, state}                                                       │
 * │     │ ──────────────┼────────────────►│ Retrieve PKCE ◄──┼────────────────┤ Lookup      │
 * │     │               │                 │ {codeVerifier}   │                │ by state    │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Exchange code ──►│ Token Exchange │             │
 * │     │               │                 │ + codeVerifier   │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Get user info ──►│ User Claims    │             │
 * │     │               │                 │ (basic claims)   │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ JIT Provision ◄──┼────────────────┤ Find or     │
 * │     │               │                 │ (Find/Create)    │                │ Create      │
 * │     │               │                 │                  │                │             │
 * │     │ App JWT       │ ◄───────────────│ Generate JWT     │                │             │
 * │     │ w/ orgRole    │                 │ payload          │                │             │
 * │                                                                                         │
 * │ App JWT Payload:                                                                        │
 * │ {                                                                                       │
 * │   "sub": "user-uuid",           // OIDC standard                                        │
 * │   "email": "user@example.com",  // OIDC standard                                        │
 * │   "name": "John Doe",           // OIDC standard                                        │
 * │   "orgRole": "admin"            // Extended: admin/member                               │
 * │ }                                                                                       │
 * │                                                                                         │
 * │ Load Balancer Benefits:                                                                 │
 * │ • PKCE data stored in shared database - any server can access                           │
 * │ • Stateless authentication - no server affinity required                                │
 * │ • App JWT includes organizational context derived during JIT provisioning               │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly identityService: IdentityService
  ) {}

  @PublicRoute()
  @HttpCode(HttpStatusCode.Found)
  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    const result = await pipe(
      this.authService.initiateOidcLogin(),
      logSuccess("OIDC login initiated", "AuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Failed to initiate OIDC login", result.left)
      res.redirect("/auth/error")
      return
    }

    Logger.debug(`Redirecting to OIDC provider: ${result.right}`)
    res.redirect(result.right)
  }

  @PublicRoute()
  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") state: string, @Res() res: Response): Promise<void> {
    if (!code || !state) {
      Logger.error("Missing code or state in OIDC callback")
      res.redirect("/auth/error")
      return
    }

    // Redirect to success page with code and state for frontend to exchange for JWT
    res.redirect(`/auth/success?code=${code}&state=${state}`)
  }

  @PublicRoute()
  @Post("token")
  async generateToken(@Body() body: TokenRequest): Promise<TokenResponse> {
    const runOidcLogin = (req: TokenRequest) => this.authService.completeOidcLogin(req.code, req.state)

    const result = await pipe(
      body,
      TE.right,
      TE.chainW(raw => TE.fromEither(validateGenerateTokenRequest(raw))),
      TE.chainW(validated => runOidcLogin(validated)),
      TE.map(mapToTokenResponse),
      logSuccess("Token generated", "AuthController")
    )()

    if (isLeft(result)) {
      Logger.error("OIDC login completion failed", result.left)
      throw generateErrorResponseForGenerateToken(result.left, "Failed to generate token")
    }

    return result.right
  }

  @PublicRoute()
  @Get("success")
  async success(@Query("code") code: string, @Query("state") state: string): Promise<SuccessfulAuthResponse> {
    if (!code) throw new BadRequestException(generateErrorPayload("MISSING_CODE", "missing code"))
    if (!state) throw new BadRequestException(generateErrorPayload("MISSING_STATE", "missing state"))
    return {
      message: "Authentication successful. Use the code and state to generate a JWT token.",
      code: code,
      state: state,
      b64encoded: Buffer.from(`${code}:${state}`, "utf-8").toString("base64")
    }
  }

  @PublicRoute()
  @Get("error")
  async error(): Promise<FailedAuthResponse> {
    return {message: "Authentication failed. Please try again."}
  }

  @Get("info")
  async getEntityInfo(
    @GetAuthenticatedEntity() authenticatedEntity: AuthenticatedEntity
  ): Promise<GetUserInfo200Response> {
    const result = await pipe(
      this.identityService.getIdentityGroups(authenticatedEntity),
      TE.map(groups => mapToEntityInfoResponse(authenticatedEntity, groups))
    )()

    if (isLeft(result)) throw generateErrorResponseForEntityInfo(result.left, "Failed to fetch entity groups")

    return result.right
  }

  @PublicRoute()
  @Post("agents/challenge")
  @HttpCode(200)
  async generateAgentChallenge(@Body() request: unknown): Promise<AgentChallengeResponse> {
    const mapRequest = (req: AgentChallengeRequest) => mapAgentChallengeRequestToService(req)
    const generateChallenge = (req: GenerateChallengeRequest) => this.authService.generateAgentChallenge(req)

    const result = await pipe(
      request,
      TE.right,
      TE.chainW(r => TE.fromEither(validateAgentChallengeRequest(r))),
      TE.chainW(r => TE.fromEither(mapRequest(r))),
      TE.chainW(r => generateChallenge(r)),
      logSuccess("Agent challenge generated", "AuthController")
    )()

    if (isLeft(result)) throw generateErrorResponseForChallengeRequest(result.left, "Failed to generate challenge")

    return mapChallengeToApiResponse(result.right)
  }

  @PublicRoute()
  @Post("agents/token")
  @HttpCode(200)
  async exchangeAgentToken(@Body() request: unknown): Promise<AgentTokenResponse> {
    const validateRequest = (req: unknown) => validateAgentTokenRequest(req)
    const extractAssertion = (validatedReq: AgentTokenRequest) => validatedReq.clientAssertion
    const exchangeToken = (assertion: string) => this.authService.exchangeJwtAssertionForToken(assertion)

    const result = await pipe(
      request,
      validateRequest,
      TE.fromEither,
      TE.map(extractAssertion),
      TE.chainW(exchangeToken),
      TE.map(mapTokenToApiResponse),
      logSuccess("Agent token exchanged", "AuthController")
    )()

    if (isLeft(result))
      throw generateErrorResponseForAgentTokenExchange(result.left, "Failed to exchange JWT assertion for token")

    return result.right
  }

  @PublicRoute()
  @Post("refresh")
  @HttpCode(200)
  async refreshUserToken(@Body() body: RefreshTokenRequest): Promise<TokenResponse> {
    const refreshUserToken = (refreshToken: string) => this.authService.refreshTokenForUser(refreshToken)

    const result = await pipe(
      body,
      TE.right,
      TE.chainW(rawBody => TE.fromEither(validateRefreshTokenRequest(rawBody))),
      TE.chainW(validatedBody => refreshUserToken(validatedBody.refreshToken)),
      TE.map(serviceResult => mapToTokenResponse(serviceResult)),
      logSuccess("User token refreshed", "AuthController")
    )()

    if (isLeft(result)) {
      Logger.error("User token refresh failed", result.left)
      throw generateErrorResponseForRefreshUserToken(result.left, "Failed to refresh token")
    }

    return result.right
  }

  @PublicRoute()
  @Post("agents/refresh")
  @HttpCode(200)
  async refreshAgentToken(
    @Body() body: RefreshTokenRequest,
    @Headers("DPoP") dpop: string,
    @Req() request: Request
  ): Promise<TokenResponse> {
    const refreshAgentToken = (refreshToken: string, dpopJkt: string) =>
      this.authService.refreshTokenForAgent(refreshToken, dpopJkt, {
        expectedMethod: "POST",
        expectedUrl: `${request.protocol}://${request.get("host") ?? ""}${request.originalUrl}`
      })

    const result = await pipe(
      body,
      TE.right,
      TE.chainW(rawBody => TE.fromEither(validateRefreshAgentTokenRequest(rawBody, dpop))),
      TE.chainW(validatedBody => refreshAgentToken(validatedBody.refreshToken, validatedBody.dpopJkt)),
      TE.map(serviceResult => mapToTokenResponse(serviceResult)),
      logSuccess("Agent token refreshed", "AuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Agent token refresh failed", result.left)
      throw generateErrorResponseForRefreshAgentToken(result.left, "Failed to refresh token")
    }

    return result.right
  }

  @PublicRoute()
  @HttpCode(HttpStatusCode.Found)
  @Get("initiatePrivilegedTokenExchange")
  async initiatePrivilegeToken(@Res() res: Response): Promise<void> {
    const runInitiation = () => this.authService.initiatePrivilegeTokenGeneration()

    const result = await pipe(runInitiation(), logSuccess("Privilege token initiation started", "AuthController"))()

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
      body,
      TE.right,
      TE.chainW(rawBody => TE.fromEither(validateExchangePrivilegeTokenRequest(rawBody))),
      TE.chainEitherKW(mapToPrivilegeTokenExchange),
      TE.chainW(mappedRequest => this.authService.exchangePrivilegeToken(mappedRequest, requestor)),
      TE.map(accessToken => ({accessToken})),
      logSuccess("Privilege token exchanged", "AuthController")
    )()

    if (isLeft(result)) {
      Logger.error("Privilege token exchange failed", result.left)
      throw generateErrorResponseForExchangePrivilegeToken(result.left, "Failed to exchange privilege token")
    }

    return result.right
  }
}
