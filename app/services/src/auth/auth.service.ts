import {Injectable, Inject, Logger} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
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
  Account,
  User,
  AccountRefreshTokenFactory,
  AgentRefreshTokenFactory,
  canTokenBeRefreshed,
  RefreshToken,
  AuthenticatedEntity,
  AuthenticatedBrowserSession,
  AuthenticatedPlatformSession,
  isOrganizationId,
  StepUpOperation,
  StepUpContext,
  StepUpReceipt,
  StepUpReceiptClaim,
  StepUpReceiptFactory,
  AuthorityError,
  BoundaryError,
  MutationError,
  TenantContext,
  REFRESH_TOKEN_EXPIRY_DAYS
} from "@domain"
import {
  OIDC_PROVIDER_TOKEN,
  OidcProvider,
  OidcTokenResponse,
  OidcUserInfo,
  PkceData,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  AgentChallengeRepository,
  AgentChallengeCreateError,
  AgentTokenError,
  ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  AccountRefreshTokenRepository,
  AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN,
  AgentRefreshTokenRepository,
  RefreshTokenRefreshError,
  TokenPair,
  AccessToken,
  RefreshTokenCreateError,
  AuthError,
  DPOP_TOKEN_REPOSITORY_TOKEN,
  DpopTokenRepository,
  UseHighPrivilegeTokenError,
  PrivilegeTokenExchange,
  AssuranceLevel,
  HighPrivilegeAuthError,
  PrivilegedToken
} from "./interfaces"
import {
  MEMBERSHIP_REPOSITORY_TOKEN,
  MembershipRepository,
  PLATFORM_IDENTITY_REPOSITORY_TOKEN,
  PlatformIdentityRepository,
  PROVIDER_CONNECTION_REPOSITORY_TOKEN,
  ProviderConnectionRepository,
  SESSION_REPOSITORY_TOKEN,
  SessionRepository,
  STEP_UP_RECEIPT_REPOSITORY_TOKEN,
  StepUpReceiptRepository
} from "../tenancy/interfaces"
import {TokenPayloadBuilder} from "./auth-token"
import {createSha256Hash, validateDpopJwt, logSuccess, DPOP_MAX_AGE_SECONDS, CLOCK_SKEW_TOLERANCE_SECONDS} from "@utils"
import {AgentService} from "@services/agent"
import {RepositoryDependencyError} from "../error"
import {v7 as uuidv7} from "uuid"

import {LeverService} from "../lever"
import {AuthProvider} from "@approvio/api"
import {Task} from "fp-ts/Task"
import {ExecutionError, TRANSACTION_MANAGER_TOKEN, TenantTransactionManager} from "@services/transaction/interfaces"
import {inTransaction} from "@services/transaction/in-transaction"

const ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60 // 1 hour
const STEP_UP_TOKEN_EXPIRY_SECONDS = 60 * 2 // 2 minutes

export interface OidcUser {
  oidcSubjectId: string
  displayName: string
  profileEmail: string
  providerId: string
  issuer: string
}

@Injectable()
export class AuthService {
  private readonly audience: string
  private readonly issuer: string
  private readonly accessTokenExpirationSec: number

  constructor(
    private readonly jwtService: JwtService,
    private readonly pkceService: PkceService,
    private readonly configProvider: ConfigProvider,
    @Inject(OIDC_PROVIDER_TOKEN)
    private readonly oidcClient: OidcProvider,
    @Inject(AGENT_CHALLENGE_REPOSITORY_TOKEN)
    private readonly challengeRepo: AgentChallengeRepository,
    private readonly agentService: AgentService,
    @Inject(ACCOUNT_REFRESH_TOKEN_REPOSITORY_TOKEN)
    private readonly accountRefreshTokenRepo: AccountRefreshTokenRepository,
    @Inject(AGENT_REFRESH_TOKEN_REPOSITORY_TOKEN)
    private readonly agentRefreshTokenRepo: AgentRefreshTokenRepository,
    @Inject(DPOP_TOKEN_REPOSITORY_TOKEN)
    private readonly dpopTokenRepo: DpopTokenRepository,
    @Inject(PLATFORM_IDENTITY_REPOSITORY_TOKEN)
    private readonly platformIdentityRepo: PlatformIdentityRepository,
    @Inject(SESSION_REPOSITORY_TOKEN)
    private readonly sessionRepo: SessionRepository,
    @Inject(MEMBERSHIP_REPOSITORY_TOKEN)
    private readonly membershipRepo: MembershipRepository,
    @Inject(PROVIDER_CONNECTION_REPOSITORY_TOKEN)
    private readonly providerConnectionRepo: ProviderConnectionRepository,
    @Inject(STEP_UP_RECEIPT_REPOSITORY_TOKEN)
    private readonly stepUpReceiptRepo: StepUpReceiptRepository,
    private readonly leverService: LeverService,
    @Inject(TRANSACTION_MANAGER_TOKEN)
    private readonly txManager: TenantTransactionManager
  ) {
    const {audience, issuer, accessTokenExpirationSec} = this.configProvider.jwtConfig

    this.audience = audience
    this.issuer = issuer
    this.accessTokenExpirationSec = accessTokenExpirationSec ?? ACCESS_TOKEN_EXPIRY_SECONDS
  }

  private generateJwtToken(
    user: User,
    providerId: string,
    session: {id: string; contextVersion: bigint},
    stepUpContext?: StepUpContext & {expiresInSeconds: number}
  ): TaskEither<
    BoundaryError | "account_not_found" | "auth_token_generation_failed" | RepositoryDependencyError,
    string
  > {
    return pipe(
      this.platformIdentityRepo.getAccountById(user.accountId),
      TE.chainW(account =>
        TE.fromEither(
          E.tryCatch(
            () => {
              const tokenPayload = TokenPayloadBuilder.fromUser(user, {
                issuer: this.issuer,
                audience: [this.audience],
                email: account.profileEmail,
                providerId,
                sessionId: session.id,
                sessionContextVersion: session.contextVersion,
                stepUpContext
              })

              const expiresIn = stepUpContext ? stepUpContext.expiresInSeconds : this.accessTokenExpirationSec
              return this.jwtService.sign(tokenPayload, {expiresIn})
            },
            error => {
              Logger.error("Error generating JWT token", error)
              return "auth_token_generation_failed" as const
            }
          )
        )
      ),
      logSuccess(`JWT token generated for user: ${user.id}`, "AuthService")
    )
  }

  private generatePlatformJwtToken(
    account: Account,
    session: {id: string; providerId: string; contextVersion: bigint}
  ): Either<AuthError, string> {
    return E.tryCatch(
      () =>
        this.jwtService.sign(
          TokenPayloadBuilder.fromPlatformAccount(account, {
            issuer: this.issuer,
            audience: [this.audience],
            sessionId: session.id,
            providerId: session.providerId,
            sessionContextVersion: session.contextVersion
          }),
          {expiresIn: this.accessTokenExpirationSec}
        ),
      error => {
        Logger.error("Error generating platform JWT token", error)
        return "auth_token_generation_failed" as const
      }
    )
  }

  /**
   * Resolves an existing account or creates a new account from OIDC provider data.
   * Accounts are identified by provider, issuer, and subject; matching email addresses do not link accounts.
   *
   * @param oidcUser - OIDC identity and profile data used to resolve or create the account
   * @returns TaskEither with AuthError on failure or the resolved or newly created Account
   *
   * Flow:
   * 1. Looks up the identity by provider, issuer, and subject.
   * 2. If the identity exists, returns its account.
   * 3. If the identity is missing, creates a separate account and identity.
   * 4. Returns lookup or creation errors, including concurrent identity creation conflicts.
   */
  private resolveOrCreateOidcAccount(oidcUser: OidcUser): TaskEither<AuthError, Account> {
    return pipe(
      this.platformIdentityRepo.resolveIdentity({
        providerId: oidcUser.providerId,
        issuer: oidcUser.issuer,
        subject: oidcUser.oidcSubjectId
      }),
      TE.orElseW(error => {
        if (error !== "account_not_found") return TE.left(error)

        return this.platformIdentityRepo.createIdentity({
          providerId: oidcUser.providerId,
          issuer: oidcUser.issuer,
          subject: oidcUser.oidcSubjectId,
          displayName: oidcUser.displayName,
          profileEmail: oidcUser.profileEmail
        })
      })
    )
  }

  private exchangeCodeForTokens(
    code: string,
    pkceData: PkceData
  ): TaskEither<AuthError | RepositoryDependencyError, OidcTokenResponse> {
    return pipe(
      this.providerConnectionRepo.getById(pkceData.providerId),
      TE.chainW(connection =>
        this.oidcClient.exchangeCodeForTokens({
          grantType: "authorization_code",
          code,
          redirectUri: pkceData.redirectUri,
          codeVerifier: pkceData.codeVerifier,
          providerId: connection.configReference
        })
      )
    )
  }

  private getUserInfoFromProvider(
    accessToken: string,
    expectedSubject: string,
    providerId: string
  ): TaskEither<AuthError | RepositoryDependencyError, OidcUserInfo> {
    return pipe(
      this.providerConnectionRepo.getById(providerId),
      TE.chainW(connection => this.oidcClient.getUserInfo(accessToken, expectedSubject, connection.configReference))
    )
  }

  private verifyAssuranceLevel(
    idToken: string,
    assuranceLevel: AssuranceLevel,
    providerId: string
  ): TaskEither<AuthError | RepositoryDependencyError, void> {
    return pipe(
      this.providerConnectionRepo.getById(providerId),
      TE.chainW(connection =>
        TE.fromEither(this.oidcClient.verifyAssuranceLevel(idToken, assuranceLevel, connection.configReference))
      )
    )
  }

  private authenticateWithOidc(
    code: string,
    pkceData: PkceData
  ): TaskEither<AuthError | RefreshTokenCreateError, TokenPair> {
    const mapUserInfoToOidcUser = (
      userInfo: OidcUserInfo,
      providerConnection: {id: string; issuer: string}
    ): E.Either<AuthError, OidcUser> => {
      if (!userInfo.email) {
        Logger.warn("OIDC provider did not return email claim")
        return E.left("auth_missing_email_from_oidc_provider")
      }
      if (userInfo.emailVerified !== true) {
        Logger.warn("OIDC provider returned unverified email")
        return E.left("auth_missing_email_from_oidc_provider")
      }

      return E.right({
        oidcSubjectId: userInfo.sub,
        displayName: userInfo.name || userInfo.preferredUsername || userInfo.sub,
        providerId: providerConnection.id,
        issuer: providerConnection.issuer,
        profileEmail: userInfo.email
      })
    }

    return pipe(
      TE.Do,
      TE.bindW("providerConnection", () => this.providerConnectionRepo.getById(pkceData.providerId)),
      TE.bindW("tokenResponse", () => this.exchangeCodeForTokens(code, pkceData)),
      TE.bindW("idTokenClaims", ({tokenResponse}) =>
        TE.fromEither(this.extractSubFromIdToken(tokenResponse.idToken, "authentication flow"))
      ),
      TE.bindW("userInfo", ({tokenResponse, idTokenClaims}) =>
        this.getUserInfoFromProvider(tokenResponse.accessToken, idTokenClaims.sub, pkceData.providerId)
      ),
      TE.bindW("oidcUser", ({userInfo, providerConnection}) =>
        TE.fromEither(mapUserInfoToOidcUser(userInfo, providerConnection))
      ),
      TE.bindW("account", ({oidcUser}) => this.resolveOrCreateOidcAccount(oidcUser)),
      TE.bindW("session", ({account}) =>
        this.sessionRepo.create({
          id: uuidv7(),
          accountId: account.id,
          providerId: pkceData.providerId,
          transport: pkceData.flow === "initial_cli_login" ? "cli" : "browser",
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
        })
      ),
      TE.bindW("accessToken", ({account, session}) => TE.fromEither(this.generatePlatformJwtToken(account, session))),
      TE.bindW("refreshToken", ({account, session}) =>
        TE.fromEither(AccountRefreshTokenFactory.create(account.id, session.id, session.providerId))
      ),
      TE.chainFirstW(({refreshToken}) => this.accountRefreshTokenRepo.createToken(refreshToken)),
      TE.map(({accessToken, refreshToken}) => ({
        accessToken,
        refreshToken: refreshToken.tokenValue,
        accessTokenExpiresInSec: this.accessTokenExpirationSec,
        refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
      })),
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

  getWebSessionContext(
    principal: AuthenticatedBrowserSession
  ): TaskEither<AuthorityError | RepositoryDependencyError, WebSessionState> {
    const accountId = principal.entityType === "platform" ? principal.account.id : principal.user.accountId
    const providerId = principal.providerId
    return pipe(
      this.sessionRepo.getByAccountAndPrincipal(accountId, principal.sessionId),
      TE.chainEitherKW(session => {
        if (session.providerId !== providerId) {
          Logger.warn("Web session context rejected: token provider does not match the session provider", "AuthService")
          return E.left("invalid_credential" as const)
        }
        if (session.contextVersion !== principal.sessionContextVersion) {
          // A successful organization switch advances the version and supersedes older access tokens.
          Logger.warn(
            "Web session context rejected: token context version does not match the current session version",
            "AuthService"
          )
          return E.left("organization_context_changed" as const)
        }
        return E.right({selectedOrganizationId: session.selectedOrganizationId, occ: session.occ})
      })
    )
  }

  switchWebOrganization(
    principal: AuthenticatedBrowserSession,
    targetOrganizationId: string,
    expectedOcc: bigint
  ): TaskEither<
    MutationError | RepositoryDependencyError | "account_not_found" | "auth_token_generation_failed" | ExecutionError,
    WebOrganizationSwitch
  > {
    if (!isOrganizationId(targetOrganizationId)) return TE.left("invalid_organization_id")

    const accountId = principal.entityType === "platform" ? principal.account.id : principal.user.accountId
    const providerId = principal.providerId
    return pipe(
      TE.right(accountId),
      inTransaction(this.txManager, {organizationId: targetOrganizationId}, id =>
        this.membershipRepo.getByAccount({organizationId: targetOrganizationId}, id)
      ),
      TE.bindTo("user"),
      TE.bindW("session", () =>
        this.sessionRepo.switchContext(accountId, principal.sessionId, targetOrganizationId, expectedOcc)
      ),
      TE.bindW("accessToken", ({user, session}) => this.generateJwtToken(user, providerId, session)),
      TE.map(({session, accessToken}) => ({
        selectedOrganizationId: targetOrganizationId,
        // switchContext returns the incremented OCC for the new ETag.
        occ: session.occ,
        // The account refresh token remains bound to the same session.
        accessToken,
        accessTokenExpiresInSec: this.accessTokenExpirationSec
      }))
    )
  }

  selectCliOrganization(
    principal: AuthenticatedPlatformSession,
    organizationId: string
  ): TaskEither<
    | MutationError
    | RepositoryDependencyError
    | "account_not_found"
    | "auth_token_generation_failed"
    | RefreshTokenCreateError
    | ExecutionError,
    TokenPair
  > {
    if (!isOrganizationId(organizationId)) return TE.left("invalid_organization_id")

    return pipe(
      this.sessionRepo.getByAccountAndPrincipal(principal.account.id, principal.sessionId),
      TE.chainFirstW(session =>
        session.transport === "cli" ? TE.right(undefined) : TE.left("invalid_credential" as const)
      ),
      TE.bindTo("session"),
      inTransaction(this.txManager, {organizationId}, state =>
        pipe(
          this.membershipRepo.getByAccount({organizationId}, principal.account.id),
          TE.map(user => ({...state, user}))
        )
      ),
      TE.bindW("updatedSession", ({session}) =>
        this.sessionRepo.switchContext(principal.account.id, principal.sessionId, organizationId, session.occ)
      ),
      TE.bindW("accessToken", ({user, updatedSession}) =>
        this.generateJwtToken(user, principal.providerId, updatedSession)
      ),
      TE.bindW("refreshToken", ({updatedSession}) =>
        TE.fromEither(
          AccountRefreshTokenFactory.create(principal.account.id, updatedSession.id, updatedSession.providerId)
        )
      ),
      TE.chainFirstW(({refreshToken}) => this.accountRefreshTokenRepo.createToken(refreshToken)),
      TE.map(({accessToken, refreshToken}) => ({
        accessToken,
        refreshToken: refreshToken.tokenValue,
        accessTokenExpiresInSec: this.accessTokenExpirationSec,
        refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
      }))
    )
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

    return this.initiateOidcLogin("initial_cli_login", providerId, AssuranceLevel.NONE, redirectUri)
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
    initialFlow: "initial_login" | "initial_cli_login",
    providerId?: string,
    assuranceLevel: AssuranceLevel = AssuranceLevel.NONE,
    redirectUri?: string
  ): TaskEither<AuthError, string> {
    return pipe(
      TE.fromEither(this.resolveProviderId(providerId)),
      TE.chainW(resolvedProviderId => this.providerConnectionRepo.getByConfigReference(resolvedProviderId)),
      TE.bindTo("providerConnection"),
      // Browser login uses the configured callback URI; CLI supplies its loopback URI.
      TE.bindW("finalRedirectUri", ({providerConnection}) =>
        redirectUri !== undefined
          ? TE.right(redirectUri)
          : TE.fromEither(this.getWebRedirectUri(providerConnection.configReference))
      ),
      TE.bindW("pkceChallenge", () => this.pkceService.generatePkceChallenge()),
      TE.chainFirstW(({pkceChallenge, providerConnection, finalRedirectUri}) =>
        this.pkceService.storePkceData(pkceChallenge.state, {
          codeVerifier: pkceChallenge.codeVerifier,
          redirectUri: finalRedirectUri,
          oidcState: pkceChallenge.state,
          providerId: providerConnection.id,
          flow: initialFlow
        })
      ),
      TE.chainEitherKW(({pkceChallenge, providerConnection, finalRedirectUri}) =>
        this.oidcClient.getAuthorizationUrl(
          pkceChallenge,
          assuranceLevel,
          finalRedirectUri,
          providerConnection.configReference
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
        this.challengeRepo.persistChallenge(request.context, challenge),
        TE.chainEitherKW(() =>
          AgentChallengeFactory.createAndEncryptServerChallengePayload(challenge, agent, this.issuer)
        )
      )
    }

    return pipe(
      TE.Do,
      inTransaction(this.txManager, request.context, () =>
        pipe(
          TE.Do,
          TE.bindW("agent", () => this.agentService.getAgentByName(request.context, request.agentName)),
          TE.bindW("challenge", ({agent}) =>
            TE.fromEither(
              AgentChallengeFactory.create({organizationId: request.context.organizationId, agentId: agent.id})
            )
          ),
          TE.chainW(({agent, challenge}) => createAndStoreChallenge(agent, challenge))
        )
      ),
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
  exchangeJwtAssertionForToken(
    context: TenantContext,
    jwtAssertion: string
  ): TaskEither<AgentTokenError | RefreshTokenCreateError, TokenPair> {
    // Marks the challenge as used in the database to prevent replay attacks
    const markChallengeAsUsed = (challenge: DecoratedAgentChallenge<{occ: true}>) => {
      return pipe(
        AgentChallengeFactory.markAsUsed(challenge, {occ: true}),
        TE.fromEither,
        TE.chainW(updatedChallenge => this.challengeRepo.updateChallenge(context, updatedChallenge))
      )
    }

    const generateToken = (agent: Agent) => TE.fromEither(this.generateJwtTokenForAgent(agent))

    return pipe(
      TE.Do,
      inTransaction(this.txManager, context, () =>
        pipe(
          TE.Do,
          // Extract agent name from JWT issuer claim
          TE.bindW("agentId", () => TE.fromEither(AgentChallengeFactory.extractAgentIdFromJwt(jwtAssertion))),
          // The assertion issuer is the immutable agent identifier, scoped by the endpoint organization.
          TE.bindW("agent", ({agentId}) => this.agentService.getAgentById(context, agentId)),
          // Validate JWT signature and claims
          TE.bindW("jwtPayload", ({agent}) =>
            TE.fromEither(AgentChallengeFactory.validateJwtAssertion(jwtAssertion, agent, this.audience))
          ),
          // Get the challenge using nonce from JWT
          TE.bindW("truthChallenge", ({jwtPayload}) => this.challengeRepo.getChallengeByNonce(context, jwtPayload.jti)),
          // Validate JWT against stored challenge
          TE.chainFirstEitherKW(({jwtPayload, truthChallenge}) =>
            AgentChallengeFactory.validateJwtAssertionAgainstTruth(jwtPayload, truthChallenge)
          ),
          // Mark challenge as used
          TE.chainFirstW(({truthChallenge}) => markChallengeAsUsed(truthChallenge)),
          // Generate access token
          TE.bindW("accessToken", ({agent}) => generateToken(agent)),
          TE.bindW("refreshToken", ({agent}) => TE.fromEither(AgentRefreshTokenFactory.create(agent))),
          TE.chainFirstW(({refreshToken}) => this.agentRefreshTokenRepo.createToken(context, refreshToken)),
          TE.map(({accessToken, refreshToken}) => ({
            accessToken,
            refreshToken: refreshToken.tokenValue,
            accessTokenExpiresInSec: this.accessTokenExpirationSec,
            refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
          })),
          logSuccess("Agent token exchanged", "AuthService")
        )
      )
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
      TE.bindW("storedToken", () => this.accountRefreshTokenRepo.getByTokenHash(tokenHash)),
      TE.bindW("oldTokenTyped", ({storedToken}) => {
        if (storedToken.entityType !== "account") return TE.left("refresh_token_entity_mismatch" as const)
        return TE.right(storedToken)
      }),
      TE.chainFirstW(({refreshTimestamp, oldTokenTyped}) =>
        this.validateTokenRefreshEligibilityOrRevoke(oldTokenTyped, refreshTimestamp)
      ),
      TE.bindW("session", ({oldTokenTyped}) =>
        this.sessionRepo.getByAccountAndPrincipal(oldTokenTyped.accountId, oldTokenTyped.sessionId)
      ),
      TE.bindW("newAccessToken", ({oldTokenTyped, session}) => {
        const organizationId = session.selectedOrganizationId
        if (organizationId !== null)
          return pipe(
            TE.Do,
            inTransaction(this.txManager, {organizationId}, () =>
              pipe(
                this.membershipRepo.getByAccount({organizationId}, oldTokenTyped.accountId),
                TE.chainW(user => this.generateJwtToken(user, oldTokenTyped.providerId, session))
              )
            )
          )

        return pipe(
          this.platformIdentityRepo.getAccountById(oldTokenTyped.accountId),
          TE.chainEitherKW(account => this.generatePlatformJwtToken(account, session))
        )
      }),
      TE.bindW("refreshedToken", ({oldTokenTyped}) =>
        TE.fromEither(
          AccountRefreshTokenFactory.create(
            oldTokenTyped.accountId,
            oldTokenTyped.sessionId,
            oldTokenTyped.providerId,
            oldTokenTyped.familyId
          )
        )
      ),
      TE.bindW("usedToken", ({oldTokenTyped, refreshedToken}) =>
        TE.fromEither(AccountRefreshTokenFactory.markAsUsed(oldTokenTyped, refreshedToken.id))
      ),
      TE.chainFirstW(({refreshedToken, usedToken, oldTokenTyped}) =>
        this.accountRefreshTokenRepo.persistNewTokenUpdateOld(refreshedToken, usedToken, oldTokenTyped.occ)
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
    context: TenantContext,
    refreshTokenValue: string,
    dpopJkt: string,
    jwtValidationProps: {expectedMethod: string; expectedUrl: string}
  ): TaskEither<RefreshTokenRefreshError, TokenPair> {
    const tokenHash = createSha256Hash(refreshTokenValue)

    return pipe(
      TE.Do,
      inTransaction(this.txManager, context, () =>
        pipe(
          TE.Do,
          TE.bindW("refreshTimestamp", () => TE.right(new Date())),
          TE.bindW("storedToken", () => this.agentRefreshTokenRepo.getByTokenHash(context, tokenHash)),
          TE.bindW("oldTokenTyped", ({storedToken}) => {
            if (storedToken.entityType !== "agent") return TE.left("refresh_token_entity_mismatch" as const)
            if (storedToken.organizationId !== context.organizationId) return TE.left("organization_mismatch" as const)
            return TE.right(storedToken)
          }),
          TE.chainFirstW(({refreshTimestamp, oldTokenTyped}) =>
            this.validateTokenRefreshEligibilityOrRevoke(oldTokenTyped, refreshTimestamp)
          ),
          TE.bindW("agent", ({oldTokenTyped}) =>
            this.agentService.getAgentById({organizationId: oldTokenTyped.organizationId}, oldTokenTyped.agentId)
          ),
          TE.bindW("dpopValidation", ({agent}) => validateDpopJwt(dpopJkt, agent.publicKey, jwtValidationProps)),
          TE.chainFirstW(({dpopValidation}) =>
            this.dpopTokenRepo.markJtiAsUsed(
              dpopValidation.jti,
              DPOP_MAX_AGE_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 60
            )
          ),
          TE.bindW("newAccessToken", ({agent}) => TE.fromEither(this.generateJwtTokenForAgent(agent))),
          TE.bindW("refreshedToken", ({agent, oldTokenTyped}) =>
            TE.fromEither(AgentRefreshTokenFactory.create(agent, oldTokenTyped.familyId))
          ),
          TE.bindW("usedToken", ({refreshedToken, oldTokenTyped}) =>
            TE.fromEither(AgentRefreshTokenFactory.markAsUsed(oldTokenTyped, refreshedToken.id))
          ),
          TE.chainFirstW(({refreshedToken, usedToken, oldTokenTyped}) =>
            this.agentRefreshTokenRepo.persistNewTokenUpdateOld(context, refreshedToken, usedToken, oldTokenTyped.occ)
          ),
          TE.map(({newAccessToken, refreshedToken}) => ({
            accessToken: newAccessToken,
            refreshToken: refreshedToken.tokenValue,
            accessTokenExpiresInSec: this.accessTokenExpirationSec,
            refreshTokenExpiresInSec: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60
          })),
          logSuccess("Agent token refreshed", "AuthService")
        )
      ),
      // A failed rotation rolls back. Revoke a reused token family in a separate committed transaction.
      TE.orElseW(error => {
        if (error !== "refresh_token_reuse_detected") return TE.left(error)

        Logger.warn("Reuse detection: Revoking agent token family", "AuthService")
        return pipe(
          TE.Do,
          inTransaction(this.txManager, context, () =>
            pipe(
              this.agentRefreshTokenRepo.getByTokenHash(context, tokenHash),
              TE.chainW(storedToken => this.agentRefreshTokenRepo.revokeFamily(context, storedToken.familyId))
            )
          ),
          // Return the reuse failure after the revocation transaction commits.
          TE.chainW(() => TE.left(error))
        )
      })
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

        if (oldTokenTyped.entityType === "agent") return TE.left(error)

        Logger.warn(`Reuse detection: Revoking token family ${oldTokenTyped.familyId}`)
        const revoke = this.accountRefreshTokenRepo.revokeFamily(oldTokenTyped.familyId)
        return pipe(
          revoke,
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

    return this.initiateOidcLogin("initial_login", requestor.providerId, AssuranceLevel.FORCE_LOGIN)
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

    return this.initiateOidcLogin("initial_login", providerId, AssuranceLevel.FORCE_LOGIN)
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
      TE.chainFirstW(({pkceData}) => {
        // Security check 1: Provider alignment
        // Verify that the user's active session provider matches the provider bound to this PKCE challenge.
        // Prevents cross-provider confusion attacks in multi-provider environments.
        if (requestor.providerId !== pkceData.providerId) {
          Logger.warn(
            `Step-up rejected: active provider (${requestor.providerId}) does not match PKCE provider (${pkceData.providerId})`
          )
          return TE.left("auth_identity_conflict" as const)
        }
        return TE.right(undefined)
      }),
      TE.bindW("idTokenClaims", ({tokenResponse}) =>
        TE.fromEither(this.extractSubFromIdToken(tokenResponse.idToken, "step-up flow"))
      ),
      // Security check 2: Identity subject ownership verification
      // Ensure that the OIDC subject ID returned during the step-up flow belongs to the CURRENTLY AUTHENTICATED user.
      // CRITICAL: Without this check, user A who is logged in could complete the step-up flow at the IdP
      // using user B's IdP credentials, incorrectly obtaining a high-privilege token for user A.
      TE.bindW("providerConnection", ({pkceData}) => this.providerConnectionRepo.getById(pkceData.providerId)),
      TE.bindW("account", ({providerConnection, idTokenClaims}) =>
        this.platformIdentityRepo.resolveIdentity({
          providerId: providerConnection.id,
          issuer: providerConnection.issuer,
          subject: idTokenClaims.sub
        })
      ),
      TE.chainFirstW(({account, idTokenClaims}) => {
        if (account.id !== requestor.user.accountId) {
          Logger.warn(
            `Step-up identity mismatch: IdP subject ${idTokenClaims.sub} does not belong to account ${requestor.user.accountId}`
          )
          return TE.left("auth_identity_conflict" as const)
        }
        return TE.right(undefined)
      }),
      TE.chainFirstW(({pkceData, tokenResponse, idTokenClaims}) =>
        this.getUserInfoFromProvider(tokenResponse.accessToken, idTokenClaims.sub, pkceData.providerId)
      ),
      TE.chainFirstW(({pkceData, idTokenClaims}) =>
        this.verifyAssuranceLevel(idTokenClaims.idToken, AssuranceLevel.FORCE_LOGIN, pkceData.providerId)
      ),
      TE.chainW(({pkceData}) => {
        const receipt: StepUpReceipt = {
          organizationId: requestor.user.organizationId,
          jti: uuidv7(),
          userId: requestor.user.id,
          sessionId: requestor.sessionId,
          providerId: pkceData.providerId,
          contextVersion: requestor.sessionContextVersion,
          operation: request.operation,
          resourceId: request.resourceId,
          expiresAt: new Date(Date.now() + STEP_UP_TOKEN_EXPIRY_SECONDS * 1000)
        }
        return TE.right(receipt)
      }),
      TE.chainFirstW(receipt =>
        inTransaction(this.txManager, {organizationId: requestor.user.organizationId}, () =>
          this.stepUpReceiptRepo.issue({organizationId: requestor.user.organizationId}, receipt)
        )(TE.Do)
      ),
      TE.chainW(receipt =>
        this.generateJwtToken(
          requestor.user,
          receipt.providerId,
          {
            id: requestor.sessionId,
            contextVersion: requestor.sessionContextVersion
          },
          {
            operation: request.operation,
            resource: request.resourceId,
            jti: receipt.jti,
            expiresInSeconds: STEP_UP_TOKEN_EXPIRY_SECONDS
          }
        )
      ),
      TE.map(token => ({token, expiresInSec: STEP_UP_TOKEN_EXPIRY_SECONDS})),
      logSuccess("Privilege token exchanged", "AuthService")
    )
  }

  useHighPrivilegeToken(
    entity: AuthenticatedEntity,
    operation: StepUpOperation,
    resource: string
  ): TaskEither<UseHighPrivilegeTokenError, void> {
    if (entity.entityType !== "user") return TE.left("entity_not_supported" as const)

    const stepUpContext = entity.authContext

    if (!stepUpContext) return TE.left("step_up_context_missing" as const)

    if (stepUpContext.operation !== operation) return TE.left("step_up_operation_mismatch" as const)

    if (stepUpContext.resource !== resource) return TE.left("step_up_resource_mismatch" as const)

    const receipt: StepUpReceiptClaim = {
      organizationId: entity.user.organizationId,
      jti: stepUpContext.jti,
      userId: entity.user.id,
      sessionId: entity.sessionId,
      providerId: entity.providerId,
      contextVersion: entity.sessionContextVersion,
      operation: stepUpContext.operation,
      resourceId: resource
    }

    const context = {organizationId: entity.user.organizationId}
    return pipe(
      TE.Do,
      inTransaction(this.txManager, context, () =>
        pipe(
          this.stepUpReceiptRepo.get(context, receipt.jti),
          TE.chainEitherKW(stored => StepUpReceiptFactory.consume(stored, receipt)),
          TE.chainW(consumed => this.stepUpReceiptRepo.persist(context, consumed))
        )
      )
    )
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
  readonly context: TenantContext
}

interface WebSessionState {
  readonly selectedOrganizationId: string | null
  readonly occ: bigint
}

interface WebOrganizationSwitch extends Readonly<AccessToken> {
  readonly selectedOrganizationId: string
  readonly occ: bigint
}
