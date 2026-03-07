import {Controller, Get, Post, Body, HttpCode, Logger, Headers, Req} from "@nestjs/common"
import {Request} from "express"
import {AuthService, GenerateChallengeRequest, IdentityService} from "@services"
import {isLeft} from "fp-ts/lib/Either"
import * as TE from "fp-ts/TaskEither"
import {PublicRoute} from "../../../main/src/auth/jwt.authguard"
import {GetAuthenticatedEntity} from "../../../main/src/auth"
import {
  TokenResponse,
  AgentChallengeRequest,
  AgentChallengeResponse,
  AgentTokenResponse,
  RefreshTokenRequest,
  AgentTokenRequest,
  GetEntityInfo200Response
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
import {validateRefreshAgentTokenRequest} from "./auth.validators"
import {
  generateErrorResponseForRefreshAgentToken,
  generateErrorResponseForEntityInfo,
  mapToTokenResponse,
  mapToEntityInfoResponse
} from "./auth.mappers"
import {logSuccess} from "@utils"

/**
 * OIDC Authentication HTTP Endpoints Flow
 *
 * The authentication flows (Web, CLI, and Agents) are documented in detail
 * with Mermaid diagrams in `docs/authentication.md`.
 *
 * This controller handles agent/machine-to-machine authentication and
 * the shared /auth/info endpoint.
 *
 * - Web endpoints (including login initiation) are handled in `WebAuthController` (/auth/web/*)
 * - CLI endpoints are handled in `CliAuthController` (/auth/cli/*)
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly identityService: IdentityService
  ) {}

  @Get("info")
  async getEntityInfo(
    @GetAuthenticatedEntity() authenticatedEntity: AuthenticatedEntity
  ): Promise<GetEntityInfo200Response> {
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
}
