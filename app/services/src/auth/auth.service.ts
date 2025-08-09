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
import {
  OIDC_PROVIDER_TOKEN,
  OidcProvider,
  OidcError,
  OidcTokenRequest,
  OidcTokenResponse,
  OidcUserInfo,
  PkceData,
  PkceChallenge,
  PkceError
} from "./interfaces"
import {TokenPayloadBuilder} from "./auth-token"

export interface OidcUser {
  id: string
  email?: string
  displayName?: string
}

export type AuthError =
  | PrefixUnion<"auth", "user_not_found_in_system" | "token_generation_failed" | "authorization_url_generation_failed">
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
    private readonly oidcClient: OidcProvider
  ) {
    const {audience, issuer} = this.configProvider.jwtConfig

    this.audience = audience
    this.issuer = issuer
  }

  generateJwtToken(oidcUser: OidcUser): TaskEither<AuthError, string> {
    const generateTokenFromUser = (user: {id: string; displayName: string; email: string}) => {
      return TE.tryCatch(
        async () => {
          const tokenPayload = TokenPayloadBuilder.fromUserData({
            sub: user.id,
            entityType: "user",
            displayName: user.displayName,
            email: user.email,
            issuer: this.issuer,
            audience: [this.audience],
            expiresInSeconds: 60 * 60 // 1 hour
          })

          const token = this.jwtService.sign(tokenPayload)
          Logger.log(`JWT token generated for user: ${user.id}`)
          return token
        },
        error => {
          Logger.error("Error generating JWT token", error)
          return "auth_token_generation_failed" as const
        }
      )
    }

    return pipe(
      this.userService.getUserByIdentifier(oidcUser.id),
      TE.mapLeft((error: UserGetError): AuthError => {
        if (error === "user_not_found") {
          Logger.warn(`User with OIDC ID ${oidcUser.id} not found in system`)
          return "auth_user_not_found_in_system" as const
        }
        return error
      }),
      TE.chainW(generateTokenFromUser)
    )
  }

  exchangeCodeForTokens(code: string, pkceData: PkceData): TaskEither<AuthError, OidcTokenResponse> {
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
    const mapUserInfoToOidcUser = (userInfo: OidcUserInfo): OidcUser => ({
      id: userInfo.sub,
      email: userInfo.email,
      displayName: userInfo.name || userInfo.preferred_username || userInfo.email
    })

    return pipe(
      this.exchangeCodeForTokens(code, pkceData),
      TE.chainW(tokenResponse => this.getUserInfoFromProvider(tokenResponse.access_token)),
      TE.map(mapUserInfoToOidcUser),
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
}
