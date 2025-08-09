import {Injectable, Logger} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import * as client from "openid-client"
import {OidcProvider, OidcError, OidcTokenRequest, OidcTokenResponse, OidcUserInfo} from "@services/auth/interfaces"
import {OidcBootstrapService} from "./oidc-bootstrap.service"
import {RawUserInfoResponse, validateUserInfoResponse} from "./oidc-types"

@Injectable()
export class OidcClient implements OidcProvider {
  constructor(private readonly oidcBootstrapService: OidcBootstrapService) {}

  getAuthorizationEndpoint(): TaskEither<OidcError, string> {
    return TE.right(this.oidcBootstrapService.getConfiguration().authorization_endpoint)
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

        const validationResult = validateUserInfoResponse(rawUserInfoData)
        if (E.isLeft(validationResult)) {
          Logger.error("UserInfo response validation failed", {
            error: validationResult.left,
            rawData: rawUserInfoData
          })
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

        Logger.log("User info fetch completed successfully", {sub: userInfo.sub})
        return userInfo
      },
      error => {
        Logger.error("User info fetch failed", error)
        if (error instanceof Error) {
          if (error.message.includes("UserInfo validation failed")) return "oidc_invalid_provider_response" as const

          if (error.message.includes("unauthorized") || error.message.includes("invalid_token")) {
            return "oidc_userinfo_fetch_failed" as const
          }
          if (error.message.includes("network") || error.message.includes("timeout")) {
            return "oidc_network_error" as const
          }
        }
        return "oidc_userinfo_fetch_failed" as const
      }
    )
  }
}
