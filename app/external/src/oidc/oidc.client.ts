import {Injectable, Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
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

  private getAuthorizationEndpoint(): TaskEither<OidcError, string> {
    return TE.right(this.oidcBootstrapService.getConfiguration().authorization_endpoint)
  }

  getAuthorizationUrl(pkce: PkceChallenge, assuranceLevel: AssuranceLevel): TaskEither<OidcError, string> {
    return pipe(
      this.getAuthorizationEndpoint(),
      TE.chainW(authorizationEndpoint =>
        TE.tryCatch(
          async () => {
            const oidcConfig = this.configProvider.oidcConfig

            const authUrl = new URL(authorizationEndpoint)
            authUrl.searchParams.append("response_type", "code")
            authUrl.searchParams.append("client_id", oidcConfig.clientId)
            authUrl.searchParams.append("redirect_uri", oidcConfig.redirectUri)
            authUrl.searchParams.append("scope", oidcConfig.scopes || "openid profile email")
            authUrl.searchParams.append("state", pkce.state)
            authUrl.searchParams.append("code_challenge", pkce.codeChallenge)
            authUrl.searchParams.append("code_challenge_method", "S256")

            // Force login prompt for higher assurance level
            if (assuranceLevel === AssuranceLevel.FORCE_LOGIN) {
              if (
                oidcConfig.provider === "auth0" ||
                oidcConfig.provider === "zitadel" ||
                oidcConfig.provider === "keycloak"
              )
                authUrl.searchParams.append("prompt", "login")
            }

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
        Logger.log("Exchanging authorization code for tokens")

        const rawConfiguration = this.oidcBootstrapService.getRawClientConfiguration()
        const tokens = await client.genericGrantRequest(rawConfiguration, "authorization_code", {
          code: request.code,
          redirect_uri: request.redirect_uri,
          code_verifier: request.code_verifier
        })

        const tokenResponse: OidcTokenResponse = {
          access_token: tokens.access_token,
          token_type: tokens.token_type || "Bearer",
          expires_in: tokens.expires_in,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
          id_token: tokens.id_token
        }

        Logger.log("Token exchange completed successfully")
        return tokenResponse
      },
      error => {
        Logger.error("Token exchange failed", error)
        if (error instanceof Error) {
          if (error.message.includes("invalid_grant") || error.message.includes("authorization code")) {
            return "oidc_token_exchange_failed" as const
          }
          if (error.message.includes("network") || error.message.includes("timeout")) {
            return "oidc_network_error" as const
          }
        }
        return "oidc_token_exchange_failed" as const
      }
    )
  }

  getUserInfo(accessToken: string): TaskEither<OidcError, OidcUserInfo> {
    return TE.tryCatch(
      async () => {
        Logger.log("Fetching user info from OIDC provider")

        const configuration = this.oidcBootstrapService.getConfiguration()
        const rawConfiguration = this.oidcBootstrapService.getRawClientConfiguration()
        const userinfoUrl = new URL(configuration.userinfo_endpoint)
        const response = await client.fetchProtectedResource(rawConfiguration, accessToken, userinfoUrl, "GET")
        const rawUserInfoData = (await response.json()) as RawUserInfoResponse

        Logger.verbose(`Raw UserInfo response received: ${JSON.stringify(rawUserInfoData)}`)

        const validationResult = validateUserInfoResponse(rawUserInfoData)
        if (E.isLeft(validationResult)) {
          Logger.error("UserInfo response validation failed", validationResult.left)
          throw new Error(`UserInfo validation failed: ${validationResult.left}`)
        }

        const validatedUserInfo = validationResult.right
        const userInfo: OidcUserInfo = {
          sub: validatedUserInfo.sub,
          name: validatedUserInfo.name,
          email: validatedUserInfo.email,
          email_verified: validatedUserInfo.email_verified,
          preferred_username: validatedUserInfo.preferred_username,
          given_name: validatedUserInfo.given_name,
          family_name: validatedUserInfo.family_name
        }

        Logger.log(`User info fetch completed successfully for sub: ${userInfo.sub}`)
        return userInfo
      },
      error => {
        Logger.error("User info fetch failed", error)
        if (error instanceof Error) {
          if (error.message.includes("UserInfo validation failed")) return "oidc_invalid_provider_response" as const

          if (error.message.includes("unauthorized") || error.message.includes("invalid_token"))
            return "oidc_userinfo_fetch_failed" as const
          if (error.message.includes("network") || error.message.includes("timeout"))
            return "oidc_network_error" as const
        }
        return "oidc_userinfo_fetch_failed" as const
      }
    )
  }

  verifyAssuranceLevel(idToken: string, assuranceLevel: AssuranceLevel): TaskEither<OidcError, void> {
    if (assuranceLevel !== AssuranceLevel.FORCE_LOGIN) return TE.right(undefined)

    const provider = this.configProvider.oidcConfig.provider

    if (provider !== "auth0" && provider !== "zitadel" && provider !== "keycloak") {
      Logger.warn(`Assurance level verification is not supported for provider: ${provider}`)
      return TE.left("oidc_invalid_token_response" as const)
    }

    let decodedIdToken
    try {
      decodedIdToken = decodeJwt(idToken)
    } catch {
      Logger.error("Failed to decode idToken JWT")
      return TE.left("oidc_invalid_token_response" as const)
    }

    const authTime = decodedIdToken.auth_time
    if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
      Logger.warn(`Assurance level validation failed: auth_time is missing or invalid for ${provider}`)
      return TE.left("oidc_invalid_token_response" as const)
    }

    const currentEpoch = Math.floor(Date.now() / 1000)
    if (currentEpoch - authTime > STEP_UP_MAX_AGE_SECONDS) {
      const age = currentEpoch - authTime
      Logger.warn(
        `Assurance level validation failed: auth_time is older than max age (${age}s > ${STEP_UP_MAX_AGE_SECONDS}s)`
      )
      return TE.left("oidc_invalid_token_response" as const)
    }

    Logger.log(`Assurance level verified: auth_time is fresh for ${provider}`)
    return TE.right(undefined)
  }
}
