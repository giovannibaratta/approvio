import {Controller, Get, Post, Res, Logger, UnauthorizedException, Query, Body, HttpCode} from "@nestjs/common"
import {Response} from "express"
import {AuthenticatedEntity, AuthService, GenerateChallengeRequest} from "@services"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity} from "../../../main/src/auth"
import {
  TokenRequest,
  TokenResponse,
  AuthMessageResponse,
  AgentChallengeRequest,
  AgentChallengeResponse,
  AgentTokenResponse
} from "@approvio/api"

import {
  mapAgentChallengeRequestToService,
  mapChallengeToApiResponse,
  mapTokenToApiResponse,
  generateErrorResponseForChallengeRequest,
  generateErrorResponseForAgentTokenExchange,
  JwtAssertionTokenRequest,
  validateJwtAssertionTokenRequest
} from "./agent-auth.mappers"
import {pipe} from "fp-ts/lib/function"

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
  constructor(private readonly authService: AuthService) {}

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
    if (!body) {
      throw new UnauthorizedException("Missing required parameters")
    }

    const {code, state} = body

    if (!code || !state) {
      throw new UnauthorizedException("Missing required parameters")
    }

    const result = await this.authService.completeOidcLogin(code, state)()

    if (isLeft(result)) {
      Logger.error("OIDC login completion failed", result.left)
      throw new UnauthorizedException("Failed to generate token")
    }

    return {token: result.right}
  }

  @PublicRoute()
  @Get("success")
  async success(): Promise<AuthMessageResponse> {
    return {message: "Authentication successful. Use the code and state to generate a JWT token."}
  }

  @PublicRoute()
  @Get("error")
  async error(): Promise<AuthMessageResponse> {
    return {message: "Authentication failed. Please try again."}
  }

  @Get("info")
  async getUserInfo(@GetAuthenticatedEntity() authenticatedEntity: AuthenticatedEntity): Promise<{entityType: string}> {
    return {entityType: authenticatedEntity.entityType}
  }

  @PublicRoute()
  @Post("agents/challenge")
  @HttpCode(200)
  async generateAgentChallenge(@Body() request: AgentChallengeRequest): Promise<AgentChallengeResponse> {
    const mapRequest = (req: AgentChallengeRequest) => mapAgentChallengeRequestToService(req)
    const generateChallenge = (req: GenerateChallengeRequest) => this.authService.generateAgentChallenge(req)

    const result = await pipe(
      request,
      TE.right,
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
    const validateRequest = (req: unknown) => validateJwtAssertionTokenRequest(req)
    const extractAssertion = (validatedReq: JwtAssertionTokenRequest) => validatedReq.client_assertion
    const exchangeToken = (assertion: string) => this.authService.exchangeJwtAssertionForToken(assertion)

    const result = await pipe(
      request,
      validateRequest,
      TE.fromEither,
      TE.map(extractAssertion),
      TE.chainW(exchangeToken)
    )()

    if (isLeft(result))
      throw generateErrorResponseForAgentTokenExchange(result.left, "Failed to exchange JWT assertion for token")

    return mapTokenToApiResponse(result.right)
  }
}
