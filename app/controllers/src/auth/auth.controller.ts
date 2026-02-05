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
  GetUserInfo200Response
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
  validateRefreshTokenRequest
} from "./auth.validators"
import {
  generateErrorResponseForGenerateToken,
  generateErrorResponseForRefreshAgentToken,
  generateErrorResponseForRefreshUserToken,
  generateErrorResponseForEntityInfo,
  mapToTokenResponse,
  mapToEntityInfoResponse
} from "./auth.mappers"

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
 * │     │               │                 │ Store PKCE ─────────────────────►│ Session      │
 * │     │               │                 │ {state, codeV}   │                │ Storage     │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to OIDC       │                 │ OIDC Provider    │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 2. User Authentication                                                                  │
 * │     │ ─────────────────────────────────────────────────►│ User login     │              │
 * │     │               │                 │                  │ & consent      │             │
 * │     │               │                 │                  │                │             │
 * │ 3. GET /auth/callback?code=abc&state=xyz                                                │
 * │     │ ◄─────────────────────────────────────────────────│ Authorization  │              │
 * │     │               │                 │                  │ code callback  │             │
 * │     │               │                 │                  │                │             │
 * │     │ ──────────────┼────────────────►│ Any server can   │                │             │
 * │     │               │                 │ handle callback  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │ 302 Redirect  │ ◄───────────────│ Redirect to      │                │             │
 * │     │ to success    │                 │ /success?code=.. │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │                  │                │             │
 * │ 4. POST /auth/token {code, state}                                                       │
 * │     │ ──────────────┼────────────────►│ Retrieve PKCE ◄─────────────────│ Lookup by     │
 * │     │               │                 │ data from DB     │                │ state       │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Exchange code ──────────────────►│ Token        │
 * │     │               │                 │ + codeVerifier   │                │ Exchange    │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Get user info ──────────────────►│ User         │
 * │     │               │                 │ (basic claims)   │                │ Claims      │
 * │     │               │                 │                  │                │             │
 * │     │               │                 │ Lookup user ────────────────────►│ Enhanced     │
 * │     │               │                 │ orgRole & roles  │                │ User Data   │
 * │     │               │                 │                  │                │             │
 * │     │ Enhanced JWT  │ ◄───────────────│ Generate JWT     │                │             │
 * │     │ w/ orgRole,   │                 │ with enhanced    │                │             │
 * │     │ roles, etc.   │                 │ payload          │                │             │
 * │                                                                                         │
 * │ Enhanced JWT Payload:                                                                   │
 * │ {                                                                                       │
 * │   "sub": "user-uuid",           // OIDC standard                                        │
 * │   "email": "user@example.com",  // OIDC standard                                        │
 * │   "name": "John Doe",           // OIDC standard                                        │
 * │   "orgRole": "admin",           // Enhanced: admin/member                               │
 * │   "roles": [                    // Enhanced: specific permissions                       │
 * │     {"name": "approver", "scope": {"type": "space", "spaceId": "space-123"}},           │
 * │     {"name": "viewer", "scope": {"type": "group", "groupId": "group-456"}}              │
 * │   ]                                                                                     │
 * │ }                                                                                       │
 * │                                                                                         │
 * │ Load Balancer Benefits:                                                                 │
 * │ • PKCE data stored in shared database - any server can access                           │
 * │ • Stateless authentication - no server affinity required                                │
 * │ • Enhanced JWT includes organizational context not available from OIDC provider         │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly identityService: IdentityService
  ) {}

  @PublicRoute()
  @Get("login")
  async login(@Res() res: Response): Promise<void> {
    const result = await this.authService.initiateOidcLogin()()

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
      TE.map(mapToTokenResponse)
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
      TE.chainW(r => generateChallenge(r))
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
      TE.map(mapTokenToApiResponse)
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
      TE.map(serviceResult => mapToTokenResponse(serviceResult))
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
      TE.map(serviceResult => mapToTokenResponse(serviceResult))
    )()

    if (isLeft(result)) {
      Logger.error("Agent token refresh failed", result.left)
      throw generateErrorResponseForRefreshAgentToken(result.left, "Failed to refresh token")
    }

    return result.right
  }
}
