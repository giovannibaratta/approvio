import {Injectable, Inject, Logger} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {UserService, AutoRegisterOidcUserRequest} from "../user/user.service"
import {PkceService} from "./pkce.service"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {ConfigProvider} from "@external/config/config-provider"
import {decodeJwt} from "jose"
import {
  Agent,
  AgentChallenge,
  AgentChallengeFactory,
  DecoratedAgentChallenge,
  User,
  RefreshTokenFactory,
  canTokenBeRefreshed,
  RefreshToken,
  AuthenticatedEntity,
  StepUpOperation,
  StepUpContext,
  REFRESH_TOKEN_EXPIRY_DAYS
} from "@domain"
import {
  OIDC_PROVIDER_TOKEN,
  OidcProvider,
  OidcError,
  OidcTokenRequest,
  OidcTokenResponse,
  OidcUserInfo,
  PkceData,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  AgentChallengeRepository,
  AgentChallengeCreateError,
  AgentTokenError,
  REFRESH_TOKEN_REPOSITORY_TOKEN,
  RefreshTokenRepository,
  RefreshTokenRefreshError,
  TokenPair,
  RefreshTokenCreateError,
  AuthError,
  STEP_UP_TOKEN_REPOSITORY_TOKEN,
  StepUpTokenRepository,
  DPOP_TOKEN_REPOSITORY_TOKEN,
  DpopTokenRepository,
  UseHighPrivilegeTokenError,
  PrivilegeTokenExchange,
  AssuranceLevel,
  HighPrivilegeAuthError,
  PrivilegedToken
} from "./interfaces"
import {USER_IDENTITY_REPOSITORY_TOKEN, UserIdentityRepository} from "../user-identity/interfaces"
import {TokenPayloadBuilder} from "./auth-token"
import {createSha256Hash, validateDpopJwt, logSuccess, DPOP_MAX_AGE_SECONDS, CLOCK_SKEW_TOLERANCE_SECONDS} from "@utils"
import {AgentService} from "@services/agent"
import {v7 as uuidv7} from "uuid"

import {LeverService} from "../lever"
import {AuthProvider} from "@approvio/api"
import {Task} from "fp-ts/Task"

const ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60 // 1 hour
const STEP_UP_TOKEN_EXPIRY_SECONDS = 60 * 2 // 2 minutes

export interface OidcUser {
  oidcSubjectId: string
  email: string
  displayName?: string
  providerId: string
}

@Injectable()
export class AuthService {
  private readonly audience: string
  private readonly issuer: string
  private readonly accessTokenExpirationSec: number

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly pkceService: PkceService,
    private readonly configProvider: ConfigProvider,
    @Inject(OIDC_PROVIDER_TOKEN)
    private readonly oidcClient: OidcProvider,
    @Inject(AGENT_CHALLENGE_REPOSITORY_TOKEN)
    private readonly challengeRepo: AgentChallengeRepository,
    private readonly agentService: AgentService,
    @Inject(REFRESH_TOKEN_REPOSITORY_TOKEN)
    private readonly refreshTokenRepo: RefreshTokenRepository,
    @Inject(STEP_UP_TOKEN_REPOSITORY_TOKEN)
    private readonly stepUpTokenRepo: StepUpTokenRepository,
    @Inject(DPOP_TOKEN_REPOSITORY_TOKEN)
    private readonly dpopTokenRepo: DpopTokenRepository,
    @Inject(USER_IDENTITY_REPOSITORY_TOKEN)
    private readonly userIdentityRepo: UserIdentityRepository,
    private readonly leverService: LeverService
  ) {
    const {audience, issuer, accessTokenExpirationSec} = this.configProvider.jwtConfig

    this.audience = audience
    this.issuer = issuer
    this.accessTokenExpirationSec = accessTokenExpirationSec ?? ACCESS_TOKEN_EXPIRY_SECONDS
  }

  private generateJwtToken(
    user: User,
    providerId: string,
    stepUpContext?: StepUpContext & {expiresInSeconds: number}
  ): Either<AuthError, string> {
    return E.tryCatch(
      () => {
        const tokenPayload = TokenPayloadBuilder.fromUser(user, {
          issuer: this.issuer,
          audience: [this.audience],
          providerId,
          stepUpContext
        })

        const expiresIn = stepUpContext ? stepUpContext.expiresInSeconds : this.accessTokenExpirationSec
        const token = this.jwtService.sign(tokenPayload, {expiresIn})
        Logger.log(`JWT token generated for user: ${user.id}`)
        return token
      },
      error => {
        Logger.error("Error generating JWT token", error)
        return "auth_token_generation_failed" as const
      }
    )
  }

  /**
   * Authenticates an existing user or auto-registers a new user from OIDC provider data.
   * This function implements the Just-In-Time (JIT) user provisioning pattern for OIDC authentication.
   *
   * @param oidcUser - User information received from the OIDC provider including subject ID, email, and display name
   * @returns TaskEither with AuthError on failure or User domain object on success
   *
   * Flow:
   * 1. Attempts to find existing user by email
   * 2. If user exists, returns the user for authentication
   * 3. If user not found, automatically registers a new user with OIDC data
   */
  private authenticateOrRegisterOidcUser(oidcUser: OidcUser): TaskEither<AuthError, User> {
    return pipe(
      // First, try to find an existing identity for this provider+subject
      this.userIdentityRepo.findByProviderAndSubject(oidcUser.providerId, oidcUser.oidcSubjectId),
      TE.chainW(identity => this.userService.getUserByIdentifier(identity.userId)),
      TE.orElseW(() =>
        // If not found, fall back to email matching (Day-1 Identity Linking / Auto-Registration)
        pipe(
          this.userService.getUserByIdentifier(oidcUser.email),
          TE.matchEW(
            error => {
              if (error === "user_not_found") {
                Logger.log(`User with email ${oidcUser.email} not found, attempting auto-registration`)
                const autoRegisterRequest: AutoRegisterOidcUserRequest = {
                  email: oidcUser.email,
                  displayName: oidcUser.displayName || oidcUser.email,
                  providerId: oidcUser.providerId,
                  subjectId: oidcUser.oidcSubjectId
                }
                return this.userService.autoRegisterOidcUser(autoRegisterRequest)
              }

              Logger.error(`Error retrieving user: ${error}`)
              return TE.left<AuthError, User>(error)
            },
            existingUser => {
              // Day 1: Reject auto-linking across providers
              Logger.warn(
                `Identity conflict: User ${existingUser.email} exists but no identity link found for provider ${oidcUser.providerId}`
              )
              return TE.left<AuthError, User>("auth_identity_conflict")
            }
          )
        )
      )
    )
  }

  private exchangeCodeForTokens(code: string, pkceData: PkceData): TaskEither<AuthError, OidcTokenResponse> {
    const tokenRequest: OidcTokenRequest = {
      grantType: "authorization_code",
      code,
      redirectUri: pkceData.redirectUri,
      codeVerifier: pkceData.codeVerifier,
      providerId: pkceData.providerId
    }

    return this.oidcClient.exchangeCodeForTokens(tokenRequest)
  }

  private getUserInfoFromProvider(
    accessToken: string,
    expectedSubject: string,
    providerId: string
  ): TaskEither<AuthError, OidcUserInfo> {
    return pipe(
      this.oidcClient.getUserInfo(accessToken, expectedSubject, providerId),
      TE.mapLeft((error: OidcError): AuthError => {
        Logger.error("Failed to get user info from OIDC provider", error)
        return error
      })
    )
  }

  private authenticateWithOidc(
    code: string,
    pkceData: PkceData
  ): TaskEither<AuthError | RefreshTokenCreateError, TokenPair> {
    const mapUserInfoToOidcUser = (userInfo: OidcUserInfo): TE.TaskEither<AuthError, OidcUser> => {
      if (userInfo.emailVerified === false) {
        Logger.warn("OIDC provider returned unverified email")
        return TE.left("auth_missing_email_from_oidc_provider" as const) // Treating unverified email as missing/invalid for security
      }
      if (!userInfo.email) {
        Logger.warn("OIDC provider did not return email claim")
        return TE.left("auth_missing_email_from_oidc_provider" as const)
      }

      const oidcUser: OidcUser = {
        oidcSubjectId: userInfo.sub,
        email: userInfo.email,
        displayName: userInfo.name || userInfo.preferredUsername || userInfo.email,
        providerId: pkceData.providerId
      }

      return TE.right(oidcUser)
    }

    return pipe(
      this.exchangeCodeForTokens(code, pkceData),
      TE.chainW(tokenResponse =>
        pipe(
          this.extractSubFromIdToken(tokenResponse.idToken, "authentication flow"),
          TE.fromEither,
          TE.chainW(({sub}) => this.getUserInfoFromProvider(tokenResponse.accessToken, sub, pkceData.providerId))
        )
      ),
      TE.chainW(mapUserInfoToOidcUser),
      TE.chainW(oidcUser =>
        pipe(
          this.authenticateOrRegisterOidcUser(oidcUser),
          TE.chainW(user =>
            pipe(
              TE.Do,
              TE.bindW("accessToken", () => TE.fromEither(this.generateJwtToken(user, oidcUser.providerId))),
              TE.bindW("refreshToken", () =>
                TE.fromEither(RefreshTokenFactory.createForUser(user, oidcUser.providerId))
              ),
              TE.chainFirstW(({refreshToken}) => this.refreshTokenRepo.createToken(refreshToken)),
              TE.map(({accessToken, refreshToken}) => ({
                accessToken,
                refreshToken: refreshToken.tokenValue,
                accessTokenExpiresInSec: this.accessTokenExpirationSec,
                refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
              }))
            )
          )
        )
      ),
      logSuccess("OIDC authentication successful", "AuthService")
    )
  }

  getAvailableAuthProviders(): Task<Array<AuthProvider>> {
    return async () => {
      const providers: Array<AuthProvider> = []
      for (const [id, config] of this.configProvider.oidcProviders.entries()) {
        const isDisabled = await this.leverService.isAuthProviderDisabled(id)()

        if (!isDisabled)
          providers.push({
            id,
            displayName: config.displayName,
            loginUrl: `/auth/web/login?provider=${id}`
          })
      }
      return providers
    }
  }

  private resolveProviderId(requestedProviderId?: string): Either<AuthError, string> {
    if (requestedProviderId !== undefined) {
      if (!this.configProvider.oidcProviders.has(requestedProviderId))
        return E.left("auth_invalid_oidc_provider" as const)

      return E.right(requestedProviderId)
    }

    const configuredProviders = Array.from(this.configProvider.oidcProviders.keys())
    const [firstProvider, secondProvider] = configuredProviders

    if (firstProvider !== undefined && secondProvider === undefined) return E.right(firstProvider)

    if (configuredProviders.length > 1) return E.left("auth_missing_oidc_provider" as const)

    return E.left("auth_invalid_oidc_provider" as const)
  }

  private getWebRedirectUri(providerId: string): Either<AuthError, string> {
    const config = this.configProvider.oidcProviders.get(providerId)
    if (!config) return E.left("auth_invalid_oidc_provider" as const)
    return E.right(config.redirectUri)
  }

  initiateOidcLoginFromCli(redirectUri: string, providerId?: string): TaskEither<AuthError, string> {
    if (!this.isLoopbackRedirectUri(redirectUri)) return TE.left("auth_invalid_redirect_uri" as const)

    return this.initiateOidcLogin(providerId, AssuranceLevel.NONE, redirectUri)
  }

  /**
   * Initiates the OIDC authorization code flow for Web or CLI clients.
   *
   * @param providerId - Optional provider ID. When omitted in single-provider deployments,
   *   it automatically resolves to the sole configured provider. In multi-provider deployments,
   *   omitting providerId returns `auth_missing_oidc_provider` prompting the client to choose an IdP.
   * @param assuranceLevel - The required authentication assurance level (e.g. NONE or FORCE_LOGIN)
   * @param redirectUri - Optional custom redirect URI (e.g. CLI loopback callback). Defaults to the web redirect URI.
   * @returns TaskEither with AuthError on failure or the OIDC authorization URL string on success
   */
  initiateOidcLogin(
    providerId?: string,
    assuranceLevel: AssuranceLevel = AssuranceLevel.NONE,
    redirectUri?: string
  ): TaskEither<AuthError, string> {
    return pipe(
      TE.fromEither(this.resolveProviderId(providerId)),
      TE.chainW(resolvedProviderId =>
        pipe(
          redirectUri !== undefined ? TE.right(redirectUri) : TE.fromEither(this.getWebRedirectUri(resolvedProviderId)),
          TE.chainW(finalRedirectUri =>
            pipe(
              TE.Do,
              TE.bindW("pkceChallenge", () => this.pkceService.generatePkceChallenge()),
              TE.chainFirstW(({pkceChallenge}) =>
                this.pkceService.storePkceData(pkceChallenge.state, {
                  codeVerifier: pkceChallenge.codeVerifier,
                  redirectUri: finalRedirectUri,
                  oidcState: pkceChallenge.state,
                  providerId: resolvedProviderId
                })
              ),
              TE.chainW(({pkceChallenge}) =>
                TE.fromEither(
                  this.oidcClient.getAuthorizationUrl(
                    pkceChallenge,
                    assuranceLevel,
                    finalRedirectUri,
                    resolvedProviderId
                  )
                )
              )
            )
          )
        )
      )
    )
  }

  completeOidcLogin(code: string, state: string): TaskEither<AuthError | RefreshTokenCreateError, TokenPair> {
    return pipe(
      this.pkceService.retrieveAndConsumePkceData(state),
      TE.chainW(pkceData => this.authenticateWithOidc(code, pkceData))
    )
  }

  generateAgentChallenge(request: GenerateChallengeRequest): TaskEither<AgentChallengeCreateError, string> {
    const createAndStoreChallenge = (
      agent: Agent,
      challenge: AgentChallenge
    ): TaskEither<AgentChallengeCreateError, string> => {
      return pipe(
        this.challengeRepo.persistChallenge(challenge),
        TE.chainEitherKW(() =>
          AgentChallengeFactory.createAndEncryptServerChallengePayload(challenge, agent, this.issuer)
        )
      )
    }

    return pipe(
      TE.Do,
      TE.bindW("agent", () => this.agentService.getAgentByName(request.agentName)),
      TE.bindW("challenge", ({agent}) => TE.fromEither(AgentChallengeFactory.create({agentName: agent.agentName}))),
      TE.chainW(({agent, challenge}) => createAndStoreChallenge(agent, challenge)),
      logSuccess("Agent challenge generated", "AuthService", () => ({agentName: request.agentName}))
    )
  }

  private generateJwtTokenForAgent(agent: Agent): Either<AgentTokenError, string> {
    return E.tryCatch(
      () => {
        const tokenPayload = TokenPayloadBuilder.fromAgent(agent, {
          issuer: this.issuer,
          audience: [this.audience]
        })

        const token = this.jwtService.sign(tokenPayload, {expiresIn: this.accessTokenExpirationSec})
        Logger.log(`JWT token generated for agent: ${agent.agentName}`)
        return token
      },
      error => {
        Logger.error("Error generating JWT token for agent", error)
        return "agent_token_generation_failed" as const
      }
    )
  }

  /**
   * Exchanges a signed JWT assertion from an agent for a TokenPair (access and refresh tokens).
   * This implementation follows a challenge-response protocol to prevent replay attacks.
   *
   * @param jwtAssertion - The signed JWT assertion from the agent, containing the challenge nonce as 'jti'
   * @returns TaskEither with AgentTokenError or RefreshTokenCreateError on failure, or TokenPair on success
   */
  exchangeJwtAssertionForToken(jwtAssertion: string): TaskEither<AgentTokenError | RefreshTokenCreateError, TokenPair> {
    // Marks the challenge as used in the database to prevent replay attacks
    const markChallengeAsUsed = (challenge: DecoratedAgentChallenge<{occ: true}>) => {
      return pipe(
        AgentChallengeFactory.markAsUsed(challenge, {occ: true}),
        TE.fromEither,
        TE.chainW(updatedChallenge => this.challengeRepo.updateChallenge(updatedChallenge))
      )
    }

    const generateToken = (agent: Agent) => TE.fromEither(this.generateJwtTokenForAgent(agent))

    return pipe(
      TE.Do,
      // Extract agent name from JWT issuer claim
      TE.bindW("agentName", () => TE.fromEither(AgentChallengeFactory.extractAgentNameFromJwt(jwtAssertion))),
      // Get agent by name extracted from JWT
      TE.bindW("agent", ({agentName}) => this.agentService.getAgentByName(agentName)),
      // Validate JWT signature and claims
      TE.bindW("jwtPayload", ({agent}) =>
        TE.fromEither(AgentChallengeFactory.validateJwtAssertion(jwtAssertion, agent, this.audience))
      ),
      // Get the challenge using nonce from JWT
      TE.bindW("truthChallenge", ({jwtPayload}) => this.challengeRepo.getChallengeByNonce(jwtPayload.jti)),
      // Validate JWT against stored challenge
      TE.chainFirstEitherKW(({jwtPayload, truthChallenge}) =>
        AgentChallengeFactory.validateJwtAssertionAgainstTruth(jwtPayload, truthChallenge)
      ),
      // Mark challenge as used
      TE.chainFirstW(({truthChallenge}) => markChallengeAsUsed(truthChallenge)),
      // Generate access token
      TE.bindW("accessToken", ({agent}) => generateToken(agent)),
      TE.bindW("refreshToken", ({agent}) => TE.fromEither(RefreshTokenFactory.createForAgent(agent))),
      TE.chainFirstW(({refreshToken}) => this.refreshTokenRepo.createToken(refreshToken)),
      TE.map(({accessToken, refreshToken}) => ({
        accessToken,
        refreshToken: refreshToken.tokenValue,
        accessTokenExpiresInSec: this.accessTokenExpirationSec,
        refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
      })),
      logSuccess("Agent token exchanged", "AuthService")
    )
  }

  /**
   * Refresh access token for a user using refresh token
   */
  refreshTokenForUser(refreshTokenValue: string): TaskEither<RefreshTokenRefreshError, TokenPair> {
    const tokenHash = createSha256Hash(refreshTokenValue)

    return pipe(
      TE.Do,
      TE.bindW("refreshTimestamp", () => TE.right(new Date())),
      TE.bindW("storedToken", () => this.refreshTokenRepo.getByTokenHash(tokenHash)),
      TE.bindW("oldTokenTyped", ({storedToken}) => {
        if (!RefreshTokenFactory.isUserToken(storedToken)) return TE.left("refresh_token_entity_mismatch" as const)
        return TE.right(storedToken)
      }),
      TE.chainFirstW(({refreshTimestamp, oldTokenTyped}) =>
        this.validateTokenRefreshEligibilityOrRevoke(oldTokenTyped, refreshTimestamp)
      ),
      TE.bindW("user", ({oldTokenTyped}) => this.userService.getUserByIdentifier(oldTokenTyped.userId)),
      TE.bindW("newAccessToken", ({user, oldTokenTyped}) =>
        TE.fromEither(this.generateJwtToken(user, oldTokenTyped.providerId))
      ),
      TE.bindW("refreshedToken", ({user, oldTokenTyped}) =>
        TE.fromEither(RefreshTokenFactory.createForUser(user, oldTokenTyped.providerId, oldTokenTyped.familyId))
      ),
      TE.bindW("usedToken", ({oldTokenTyped, refreshedToken}) =>
        TE.fromEither(RefreshTokenFactory.markAsUsedForUser(oldTokenTyped, refreshedToken.id))
      ),
      TE.chainFirstW(({refreshedToken, usedToken, oldTokenTyped}) =>
        this.refreshTokenRepo.persistNewTokenUpdateOldForUser(refreshedToken, usedToken, oldTokenTyped.occ)
      ),
      // Return token pair
      TE.map(({newAccessToken, refreshedToken}) => ({
        accessToken: newAccessToken,
        refreshToken: refreshedToken.tokenValue,
        accessTokenExpiresInSec: this.accessTokenExpirationSec,
        refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
      })),
      logSuccess("User token refreshed", "AuthService")
    )
  }

  /**
   * Refresh access token for an agent using refresh token (with DPoP validation)
   */
  refreshTokenForAgent(
    refreshTokenValue: string,
    dpopJkt: string,
    jwtValidationProps: {expectedMethod: string; expectedUrl: string}
  ): TaskEither<RefreshTokenRefreshError, TokenPair> {
    const tokenHash = createSha256Hash(refreshTokenValue)

    return pipe(
      TE.Do,
      TE.bindW("refreshTimestamp", () => TE.right(new Date())),
      TE.bindW("storedToken", () => this.refreshTokenRepo.getByTokenHash(tokenHash)),
      TE.bindW("oldTokenTyped", ({storedToken}) => {
        if (!RefreshTokenFactory.isAgentToken(storedToken)) return TE.left("refresh_token_entity_mismatch" as const)
        return TE.right(storedToken)
      }),
      TE.chainFirstW(({refreshTimestamp, oldTokenTyped}) =>
        this.validateTokenRefreshEligibilityOrRevoke(oldTokenTyped, refreshTimestamp)
      ),
      TE.bindW("agent", ({oldTokenTyped}) => this.agentService.getAgentById(oldTokenTyped.agentId)),
      TE.bindW("dpopValidation", ({agent}) => validateDpopJwt(dpopJkt, agent.publicKey, jwtValidationProps)),
      TE.chainFirstW(({dpopValidation}) =>
        this.dpopTokenRepo.markJtiAsUsed(dpopValidation.jti, DPOP_MAX_AGE_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 60)
      ),
      TE.bindW("newAccessToken", ({agent}) => TE.fromEither(this.generateJwtTokenForAgent(agent))),
      TE.bindW("refreshedToken", ({agent, oldTokenTyped}) =>
        TE.fromEither(RefreshTokenFactory.createForAgent(agent, oldTokenTyped.familyId))
      ),
      TE.bindW("usedToken", ({refreshedToken, oldTokenTyped}) =>
        TE.fromEither(RefreshTokenFactory.markAsUsedForAgent(oldTokenTyped, refreshedToken.id))
      ),
      TE.chainFirstW(({refreshedToken, usedToken, oldTokenTyped}) =>
        this.refreshTokenRepo.persistNewTokenUpdateOldForAgent(refreshedToken, usedToken, oldTokenTyped.occ)
      ),
      TE.map(({newAccessToken, refreshedToken}) => ({
        accessToken: newAccessToken,
        refreshToken: refreshedToken.tokenValue,
        accessTokenExpiresInSec: this.accessTokenExpirationSec,
        refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
      })),
      logSuccess("Agent token refreshed", "AuthService")
    )
  }

  private validateTokenRefreshEligibilityOrRevoke(
    oldTokenTyped: RefreshToken,
    refreshTimestamp: Date
  ): TaskEither<RefreshTokenRefreshError, true> {
    return pipe(
      canTokenBeRefreshed(oldTokenTyped, refreshTimestamp),
      TE.fromEither,
      TE.orElseW(error => {
        if (error !== "refresh_token_reuse_detected") return TE.left(error)

        Logger.warn(`Reuse detection: Revoking token family ${oldTokenTyped.familyId}`)
        return pipe(
          this.refreshTokenRepo.revokeFamily(oldTokenTyped.familyId),
          // Even if the revoke operation is successful, we still want to return the error
          // as the overall operation
          TE.chainW(() => TE.left(error))
        )
      })
    )
  }

  /**
   * Initiates step-up authentication for the Web application.
   *
   * Web step-up is invoked from an existing authenticated browser session (`requestor`).
   * To prevent cross-provider identity confusion attacks, the authorization request
   * is strictly bound to the user's active session IdP (`requestor.providerId`).
   *
   * @param requestor - The authenticated user requesting the privilege token
   * @returns TaskEither with HighPrivilegeAuthError on failure or authorization URL string on success
   */
  initiatePrivilegeTokenGenerationForWeb(requestor: AuthenticatedEntity): TaskEither<HighPrivilegeAuthError, string> {
    if (!this.configProvider.isPrivilegeMode) return TE.left("auth_high_privilege_flow_disabled" as const)

    if (requestor.entityType !== "user")
      // Only users can step up using OAuth
      return TE.left("auth_invalid_entity" as const)

    return this.initiateOidcLogin(requestor.providerId, AssuranceLevel.FORCE_LOGIN)
  }

  /**
   * Initiates step-up authentication for the CLI.
   *
   * Unlike Web step-up, the CLI initiation endpoint (`GET /auth/cli/initiatePrivilegedTokenExchange`)
   * is an unauthenticated public redirect endpoint because opening a system browser cannot
   * attach custom Authorization Bearer headers. Therefore, `providerId` is optionally supplied
   * via query parameter (falling back to default in single-provider environments).
   *
   * Strict binding and verification of the user's active session and identity subject ownership
   * are enforced subsequently during token exchange in `exchangePrivilegeToken`.
   *
   * @param providerId - Optional provider ID for multi-provider deployments
   * @returns TaskEither with HighPrivilegeAuthError on failure or authorization URL string on success
   */
  initiatePrivilegeTokenGenerationForCli(providerId?: string): TaskEither<HighPrivilegeAuthError, string> {
    if (!this.configProvider.isPrivilegeMode) return TE.left("auth_high_privilege_flow_disabled" as const)

    return this.initiateOidcLogin(providerId, AssuranceLevel.FORCE_LOGIN)
  }

  /**
   * Completes the high-privilege flow by exchanging an OIDC authorization code for a short-lived high-privilege token.
   * This token is then used to authorize specific sensitive operations (step-up).
   *
   * @param request - The exchange request containing the authorization code, state, and target operation details
   * @param requestor - The authenticated user requesting the privilege token
   * @returns TaskEither with HighPrivilegeAuthError on failure, or the high-privilege JWT string on success
   */
  exchangePrivilegeToken(
    request: PrivilegeTokenExchange,
    requestor: AuthenticatedEntity
  ): TaskEither<HighPrivilegeAuthError, PrivilegedToken> {
    if (!this.configProvider.isPrivilegeMode) return TE.left("auth_high_privilege_flow_disabled" as const)

    if (requestor.entityType !== "user")
      // Only users can step up using OAuth
      return TE.left("auth_invalid_entity" as const)

    return pipe(
      this.pkceService.retrieveAndConsumePkceData(request.state),
      TE.bindTo("pkceData"),
      TE.bindW("tokenResponse", ({pkceData}) => this.exchangeCodeForTokens(request.code, pkceData)),
      TE.chainFirstW(({pkceData, tokenResponse}) => {
        // Security check 1: Provider alignment
        // Verify that the user's active session provider matches the provider bound to this PKCE challenge.
        // Prevents cross-provider confusion attacks in multi-provider environments.
        if (requestor.providerId !== pkceData.providerId) {
          Logger.warn(
            `Step-up rejected: Active session provider (${requestor.providerId}) does not match PKCE session provider (${pkceData.providerId})`
          )
          return TE.left("auth_identity_conflict" as const)
        }

        return pipe(
          this.extractSubFromIdToken(tokenResponse.idToken, "step-up flow"),
          TE.fromEither,
          TE.chainW(({idToken, sub}) =>
            pipe(
              // Security check 2: Identity subject ownership verification
              // Ensure that the OIDC subject ID returned during the step-up flow belongs to the CURRENTLY AUTHENTICATED user.
              // CRITICAL: Without this check, user A who is logged in could complete the step-up flow at the IdP
              // using user B's IdP credentials, incorrectly obtaining a high-privilege token for user A.
              this.userIdentityRepo.findByProviderAndSubject(pkceData.providerId, sub),
              TE.mapLeft((): AuthError => "auth_identity_conflict"),
              TE.chainW(identity => {
                if (identity.userId !== requestor.user.id) {
                  Logger.warn(
                    `Step-up identity mismatch: IdP subject ${sub} on provider ${pkceData.providerId} belongs to user ${identity.userId}, but active session is user ${requestor.user.id}`
                  )
                  return TE.left("auth_identity_conflict" as const)
                }
                return TE.right(undefined)
              }),
              TE.chainW(() => this.getUserInfoFromProvider(tokenResponse.accessToken, sub, pkceData.providerId)),
              TE.chainW(() =>
                TE.fromEither(
                  this.oidcClient.verifyAssuranceLevel(idToken, AssuranceLevel.FORCE_LOGIN, pkceData.providerId)
                )
              )
            )
          )
        )
      }),
      TE.chainW(({pkceData}) => {
        const jti = uuidv7()
        return pipe(
          this.stepUpTokenRepo.storeToken(jti, STEP_UP_TOKEN_EXPIRY_SECONDS),
          TE.chainW(() =>
            pipe(
              TE.fromEither(
                this.generateJwtToken(requestor.user, pkceData.providerId, {
                  operation: request.operation,
                  resource: request.resourceId,
                  jti,
                  expiresInSeconds: STEP_UP_TOKEN_EXPIRY_SECONDS
                })
              ),
              TE.map(token => ({
                token,
                expiresInSec: STEP_UP_TOKEN_EXPIRY_SECONDS
              }))
            )
          )
        )
      }),
      logSuccess("Privilege token exchanged", "AuthService")
    )
  }

  useHighPrivilegeToken(
    entity: AuthenticatedEntity,
    operation: StepUpOperation,
    resource?: string
  ): TaskEither<UseHighPrivilegeTokenError, void> {
    if (entity.entityType !== "user") return TE.left("entity_not_supported" as const)

    const stepUpContext = entity.authContext

    if (!stepUpContext) return TE.left("step_up_context_missing" as const)

    if (stepUpContext.operation !== operation) return TE.left("step_up_operation_mismatch" as const)

    if (stepUpContext.resource && stepUpContext.resource !== resource)
      return TE.left("step_up_resource_mismatch" as const)

    return this.stepUpTokenRepo.consumeToken(stepUpContext.jti)
  }

  private extractSubFromIdToken(
    idToken: string | undefined,
    context: string
  ): Either<"oidc_invalid_token_response", {idToken: string; sub: string}> {
    if (!idToken) {
      Logger.error(`OIDC authentication returned no id_token from IDP in ${context}`)
      return E.left("oidc_invalid_token_response" as const)
    }
    try {
      const claims = decodeJwt(idToken)
      if (typeof claims.sub !== "string") {
        Logger.error(`OIDC id_token missing sub claim in ${context}`)
        return E.left("oidc_invalid_token_response" as const)
      }
      return E.right({idToken, sub: claims.sub})
    } catch (error) {
      Logger.error(`Failed to decode OIDC id_token in ${context}`, error)
      return E.left("oidc_invalid_token_response" as const)
    }
  }

  private isLoopbackRedirectUri(uri: string): boolean {
    try {
      const parsed = new URL(uri)
      const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
      const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:"
      return isLoopback && isHttp
    } catch {
      return false
    }
  }
}

export interface GenerateChallengeRequest {
  readonly agentName: string
}
