import {Injectable, Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as client from "openid-client"
import {decodeJwt} from "jose"
import {
  OidcProvider,
  OidcError,
  OidcTokenRequest,
  OidcTokenResponse,
  OidcUserInfo,
  PkceChallenge,
  AssuranceLevel
} from "@services/auth/interfaces"
import {OidcBootstrapService} from "./oidc-bootstrap.service"
import {RawUserInfoResponse, validateUserInfoResponse} from "./oidc-types"
import {ConfigProvider} from "../config/config-provider"

/** Maximum allowed age (in seconds) for auth_time in step-up id_tokens */
const STEP_UP_MAX_AGE_SECONDS = 30

@Injectable()
export class OidcClient implements OidcProvider {
  constructor(
    private readonly oidcBootstrapService: OidcBootstrapService,
    private readonly configProvider: ConfigProvider
  ) {}

  private getAuthorizationEndpoint(providerId: string): Either<OidcError, string> {
    return E.right(this.oidcBootstrapService.getConfiguration(providerId).authorization_endpoint)
  }

  getAuthorizationUrl(
    pkce: PkceChallenge,
    assuranceLevel: AssuranceLevel,
    redirectUri: string,
    providerId: string
  ): Either<OidcError, string> {
    return pipe(
      this.getAuthorizationEndpoint(providerId),
      E.chainW(authorizationEndpoint =>
        E.tryCatch(
          () => {
            const oidcConfig = this.configProvider.oidcProviders.get(providerId)!

            const authUrl = new URL(authorizationEndpoint)
            authUrl.searchParams.append("response_type", "code")
            authUrl.searchParams.append("client_id", oidcConfig.clientId)
            authUrl.searchParams.append("redirect_uri", redirectUri)
            authUrl.searchParams.append("scope", oidcConfig.scopes || "openid profile email")
            authUrl.searchParams.append("state", pkce.state)
            authUrl.searchParams.append("code_challenge", pkce.codeChallenge)
            authUrl.searchParams.append("code_challenge_method", "S256")

            // Force login prompt for higher assurance level
            if (assuranceLevel === AssuranceLevel.FORCE_LOGIN)
              if (
                oidcConfig.provider === "auth0" ||
                oidcConfig.provider === "zitadel" ||
                oidcConfig.provider === "keycloak"
              )
                authUrl.searchParams.append("prompt", "login")

            return authUrl.toString()
          },
          error => {
            Logger.error("Failed to generate authorization URL", error)
            return "oidc_unknown_error" as const
          }
        )
      )
    )
  }

  exchangeCodeForTokens(request: OidcTokenRequest): TaskEither<OidcError, OidcTokenResponse> {
    return TE.tryCatch(
      async () => {
        Logger.log(`Exchanging authorization code for tokens with provider ${request.providerId}`)

        const rawConfiguration = this.oidcBootstrapService.getRawClientConfiguration(request.providerId)
        const tokens = await client.genericGrantRequest(rawConfiguration, "authorization_code", {
          code: request.code,
          redirect_uri: request.redirectUri,
          code_verifier: request.codeVerifier
        })

        const tokenResponse: OidcTokenResponse = {
          accessToken: tokens.access_token,
          tokenType: tokens.token_type || "Bearer",
          expiresIn: tokens.expires_in,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
          idToken: tokens.id_token
        }

        Logger.log("Token exchange completed successfully")
        return tokenResponse
      },
      error => {
        Logger.error("Token exchange failed", error)
        if (error instanceof Error) {
          if (error.message.includes("invalid_grant") || error.message.includes("authorization code"))
            return "oidc_token_exchange_failed" as const

          if (error.message.includes("network") || error.message.includes("timeout"))
            return "oidc_network_error" as const
        }
        return "oidc_token_exchange_failed" as const
      }
    )
  }

  getUserInfo(accessToken: string, expectedSubject: string, providerId: string): TaskEither<OidcError, OidcUserInfo> {
    return pipe(
      TE.tryCatch(
        async () => {
          Logger.log(`Fetching user info from OIDC provider ${providerId}`)

          const rawConfiguration = this.oidcBootstrapService.getRawClientConfiguration(providerId)
          const userInfoResponse: RawUserInfoResponse = await client.fetchUserInfo(
            rawConfiguration,
            accessToken,
            expectedSubject
          )
          return userInfoResponse
        },
        error => {
          Logger.error("Error while fetching user info", error)
          return "oidc_userinfo_fetch_failed" as const
        }
      ),
      TE.chainEitherKW(validateUserInfoResponse),
      TE.map(validatedUserInfo => {
        const userInfo: OidcUserInfo = {
          sub: validatedUserInfo.sub,
          name: validatedUserInfo.name,
          email: validatedUserInfo.email,
          emailVerified: validatedUserInfo.emailVerified,
          preferredUsername: validatedUserInfo.preferredUsername,
          givenName: validatedUserInfo.givenName,
          familyName: validatedUserInfo.familyName
        }

        Logger.log(`User info fetch completed successfully for sub: ${userInfo.sub}`)
        return userInfo
      }),
      TE.mapLeft(error => {
        Logger.error("User info fetch failed", error)

        if (error === "invalid_json_structure") return "oidc_invalid_provider_response" as const
        if (error === "missing_required_sub_claim") return "oidc_invalid_provider_response" as const
        if (error === "invalid_sub_claim_type") return "oidc_invalid_provider_response" as const
        if (error === "invalid_claim_type") return "oidc_invalid_provider_response" as const

        return "oidc_userinfo_fetch_failed" as const
      })
    )
  }

  verifyAssuranceLevel(
    idToken: string,
    assuranceLevel: AssuranceLevel,
    providerId: string = "google"
  ): Either<OidcError, void> {
    if (assuranceLevel !== AssuranceLevel.FORCE_LOGIN) return E.right(undefined)

    const provider = this.configProvider.oidcProviders.get(providerId)!.provider

    if (provider !== "auth0" && provider !== "zitadel" && provider !== "keycloak") {
      Logger.warn(`Assurance level verification is not supported for provider: ${provider}`)
      return E.left("oidc_invalid_token_response" as const)
    }

    let decodedIdToken: Record<string, unknown>

    try {
      decodedIdToken = decodeJwt(idToken)
    } catch {
      Logger.error("Failed to decode idToken JWT")
      return E.left("oidc_invalid_token_response" as const)
    }

    const authTime = decodedIdToken.auth_time
    if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
      Logger.warn(`Assurance level validation failed: auth_time is missing or invalid for ${provider}`)
      return E.left("oidc_invalid_token_response" as const)
    }

    const currentEpoch = Math.floor(Date.now() / 1000)
    if (currentEpoch - authTime > STEP_UP_MAX_AGE_SECONDS) {
      const age = currentEpoch - authTime
      Logger.warn(`Assurance level validation failed: token is too old (${age}s) for provider ${provider}`)
      return E.left("oidc_invalid_token_response" as const)
    }

    Logger.log(`Assurance level verified: auth_time is fresh for ${provider}`)
    return E.right(undefined)
  }
}
