import {Injectable, Inject, Logger} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {UserService} from "../user/user.service"
import {PkceService} from "./pkce.service"
import {pipe} from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import {TaskEither} from "fp-ts/TaskEither"
import {UserGetError} from "../user/interfaces"
import {PrefixUnion} from "@utils"
import {ConfigProvider} from "@external/config/config-provider"
import {Agent, AgentChallenge, AgentChallengeFactory, DecoratedAgentChallenge, User} from "@domain"
import {Versioned} from "../shared/utils"
import {
  OIDC_PROVIDER_TOKEN,
  OidcProvider,
  OidcError,
  OidcTokenRequest,
  OidcTokenResponse,
  OidcUserInfo,
  PkceData,
  PkceChallenge,
  PkceError,
  AGENT_CHALLENGE_REPOSITORY_TOKEN,
  AgentChallengeRepository,
  AgentChallengeCreateError,
  AgentTokenError
} from "./interfaces"
import {TokenPayloadBuilder} from "./auth-token"
import {AgentService} from "@services/agent"

export interface OidcUser {
  oidcSubjectId: string
  email: string
  displayName?: string
}

export type AuthError =
  | PrefixUnion<
      "auth",
      | "user_not_found_in_system"
      | "token_generation_failed"
      | "authorization_url_generation_failed"
      | "missing_email_from_oidc_provider"
    >
  | UserGetError
  | OidcError
  | PkceError

@Injectable()
export class AuthService {
  private readonly audience: string
  private readonly issuer: string

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly pkceService: PkceService,
    private readonly configProvider: ConfigProvider,
    @Inject(OIDC_PROVIDER_TOKEN)
    private readonly oidcClient: OidcProvider,
    @Inject(AGENT_CHALLENGE_REPOSITORY_TOKEN)
    private readonly challengeRepo: AgentChallengeRepository,
    private readonly agentService: AgentService
  ) {
    const {audience, issuer} = this.configProvider.jwtConfig

    this.audience = audience
    this.issuer = issuer
  }

  generateJwtToken(oidcUser: OidcUser): TaskEither<AuthError, string> {
    const generateTokenFromUser = (versionedUser: Versioned<User>) => {
      return TE.tryCatch(
        async () => {
          const tokenPayload = TokenPayloadBuilder.fromUser(versionedUser, {
            issuer: this.issuer,
            audience: [this.audience],
            expiresInSeconds: 60 * 60 // 1 hour
          })

          const token = this.jwtService.sign(tokenPayload)
          Logger.log(`JWT token generated for user: ${versionedUser.id}`)
          return token
        },
        error => {
          Logger.error("Error generating JWT token", error)
          return "auth_token_generation_failed" as const
        }
      )
    }

    return pipe(
      this.userService.getUserByIdentifier(oidcUser.email),
      TE.mapLeft((error: UserGetError): AuthError => {
        if (error === "user_not_found") {
          Logger.warn(`User with email ${oidcUser.email} not found in system`)
          return "auth_user_not_found_in_system" as const
        }
        return error
      }),
      TE.chainW(generateTokenFromUser)
    )
  }

  private exchangeCodeForTokens(code: string, pkceData: PkceData): TaskEither<AuthError, OidcTokenResponse> {
    const tokenRequest: OidcTokenRequest = {
      grant_type: "authorization_code",
      code,
      redirect_uri: pkceData.redirectUri,
      code_verifier: pkceData.codeVerifier
    }

    return this.oidcClient.exchangeCodeForTokens(tokenRequest)
  }

  private getUserInfoFromProvider(accessToken: string): TaskEither<AuthError, OidcUserInfo> {
    return pipe(
      this.oidcClient.getUserInfo(accessToken),
      TE.mapLeft((error: OidcError): AuthError => {
        Logger.error("User info fetch failed", {error})
        return error
      })
    )
  }

  private authenticateWithOidc(code: string, pkceData: PkceData): TaskEither<AuthError, string> {
    const mapUserInfoToOidcUser = (userInfo: OidcUserInfo): TE.TaskEither<AuthError, OidcUser> => {
      if (!userInfo.email) {
        Logger.warn("OIDC provider did not return email claim")
        return TE.left("auth_missing_email_from_oidc_provider" as const)
      }

      const oidcUser: OidcUser = {
        oidcSubjectId: userInfo.sub,
        email: userInfo.email,
        displayName: userInfo.name || userInfo.preferred_username || userInfo.email
      }

      return TE.right(oidcUser)
    }

    return pipe(
      this.exchangeCodeForTokens(code, pkceData),
      TE.chainW(tokenResponse => this.getUserInfoFromProvider(tokenResponse.access_token)),
      TE.chainW(mapUserInfoToOidcUser),
      TE.chainW(oidcUser => this.generateJwtToken(oidcUser))
    )
  }

  private getRedirectUri(): string {
    return this.configProvider.oidcConfig.redirectUri
  }

  private generateAuthorizationUrl(pkceChallenge: PkceChallenge): TaskEither<AuthError, string> {
    return pipe(
      this.oidcClient.getAuthorizationEndpoint(),
      TE.chainW((authorizationEndpoint: string) =>
        TE.tryCatch(
          async () => {
            const oidcConfig = this.configProvider.oidcConfig

            const authUrl = new URL(authorizationEndpoint)
            authUrl.searchParams.append("response_type", "code")
            authUrl.searchParams.append("client_id", oidcConfig.clientId)
            authUrl.searchParams.append("redirect_uri", oidcConfig.redirectUri)
            authUrl.searchParams.append("scope", "openid profile email")
            authUrl.searchParams.append("state", pkceChallenge.state)
            authUrl.searchParams.append("code_challenge", pkceChallenge.codeChallenge)
            authUrl.searchParams.append("code_challenge_method", "S256")

            return authUrl.toString()
          },
          error => {
            Logger.error("Failed to generate authorization URL", error)
            return "auth_authorization_url_generation_failed" as const
          }
        )
      )
    )
  }

  initiateOidcLogin(): TaskEither<AuthError, string> {
    return pipe(
      TE.Do,
      TE.bindW("pkceChallenge", () => this.pkceService.generatePkceChallenge()),
      TE.chainFirstW(({pkceChallenge}) =>
        this.pkceService.storePkceData(pkceChallenge.state, {
          codeVerifier: pkceChallenge.codeVerifier,
          redirectUri: this.getRedirectUri(),
          oidcState: pkceChallenge.state
        })
      ),
      TE.chainW(({pkceChallenge}) => this.generateAuthorizationUrl(pkceChallenge))
    )
  }

  completeOidcLogin(code: string, state: string): TaskEither<AuthError, string> {
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
      TE.chainW(({agent, challenge}) => createAndStoreChallenge(agent, challenge))
    )
  }

  private generateJwtTokenForAgent(agent: Agent): TaskEither<AgentTokenError, string> {
    return TE.tryCatch(
      async () => {
        const tokenPayload = TokenPayloadBuilder.fromAgent(agent, {
          issuer: this.issuer,
          audience: [this.audience],
          expiresInSeconds: 60 * 60 // 1 hour
        })

        const token = this.jwtService.sign(tokenPayload)
        Logger.log(`JWT token generated for agent: ${agent.agentName}`)
        return token
      },
      error => {
        Logger.error("Error generating JWT token for agent", error)
        return "agent_token_generation_failed" as const
      }
    )
  }

  exchangeJwtAssertionForToken(jwtAssertion: string): TaskEither<AgentTokenError, string> {
    // Marks the challenge as used in the database to prevent replay attacks
    const markChallengeAsUsed = (challenge: DecoratedAgentChallenge<{occ: true}>) => {
      return pipe(
        AgentChallengeFactory.markAsUsed(challenge, {occ: true}),
        TE.fromEither,
        TE.chainW(updatedChallenge => this.challengeRepo.updateChallenge(updatedChallenge))
      )
    }

    const generateToken = (agent: Agent) => this.generateJwtTokenForAgent(agent)

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
      TE.chainW(({agent}) => generateToken(agent))
    )
  }
}

export interface GenerateChallengeRequest {
  readonly agentName: string
}
