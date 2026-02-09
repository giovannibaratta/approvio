import {Injectable, Logger, OnApplicationBootstrap} from "@nestjs/common"
import {TaskEither} from "fp-ts/TaskEither"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import * as client from "openid-client"
import {OidcError} from "@services/auth/interfaces"
import {ConfigProvider} from "../config/config-provider"
import {OidcProviderConfig} from "../config/interfaces"
import {OidcServerMetadata} from "./oidc-types"
import {isLeft} from "fp-ts/lib/Either"

@Injectable()
export class OidcBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OidcBootstrapService.name)
  private rawConfiguration: client.Configuration | null = null
  private validatedConfiguration: OidcServerMetadata | null = null

  constructor(private readonly configProvider: ConfigProvider) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log("Initializing OIDC configuration during bootstrap...")

    const configurationResult = await this.createConfiguration()()

    if (isLeft(configurationResult)) {
      const error = configurationResult.left
      this.logger.error("OIDC configuration initialization failed during bootstrap", {error})
      throw new Error(
        `Failed to initialize OIDC provider discovery: ${error}. ` +
          "Application startup aborted. Please check OIDC configuration and provider availability."
      )
    }

    this.rawConfiguration = configurationResult.right
    this.validatedConfiguration = this.validateAndTransformConfiguration(this.rawConfiguration)
    this.logger.log("OIDC configuration validated successfully during bootstrap")
    this.logger.log(`OIDC issuer: ${this.validatedConfiguration.issuer}`)
  }

  private createConfiguration(): TaskEither<OidcError, client.Configuration> {
    return pipe(
      this.configProvider.oidcConfig,
      TE.right,
      TE.chainW((oidcConfig: OidcProviderConfig) =>
        TE.tryCatch(
          async () => {
            // Check if manual configuration is provided
            const hasManualConfig =
              oidcConfig.authorizationEndpoint || oidcConfig.tokenEndpoint || oidcConfig.userinfoEndpoint

            if (hasManualConfig) {
              if (
                !oidcConfig.authorizationEndpoint ||
                !oidcConfig.tokenEndpoint ||
                !oidcConfig.userinfoEndpoint
              ) {
                const missing = []
                if (!oidcConfig.authorizationEndpoint) missing.push("OIDC_AUTHORIZATION_ENDPOINT")
                if (!oidcConfig.tokenEndpoint) missing.push("OIDC_TOKEN_ENDPOINT")
                if (!oidcConfig.userinfoEndpoint) missing.push("OIDC_USERINFO_ENDPOINT")

                throw new Error(
                  `Incomplete manual OIDC configuration. If providing manual endpoints, all of authorization, token, and userinfo endpoints must be specified. Missing: ${missing.join(
                    ", "
                  )}`
                )
              }

              this.logger.log(`Initializing OIDC configuration manually for issuer ${oidcConfig.issuerUrl}`)

              const serverMetadata = {
                issuer: oidcConfig.issuerUrl,
                authorization_endpoint: oidcConfig.authorizationEndpoint,
                token_endpoint: oidcConfig.tokenEndpoint,
                userinfo_endpoint: oidcConfig.userinfoEndpoint
              }

              return new client.Configuration(serverMetadata, oidcConfig.clientId, oidcConfig.clientSecret)
            }

            this.logger.log(`Initializing OIDC discovery from ${oidcConfig.issuerUrl}`)

            const options: client.DiscoveryRequestOptions = {
              execute:
                oidcConfig.allowInsecure !== undefined && oidcConfig.allowInsecure === true
                  ? [client.allowInsecureRequests]
                  : []
            }

            const config = await client.discovery(
              new URL(oidcConfig.issuerUrl),
              oidcConfig.clientId,
              oidcConfig.clientSecret,
              undefined,
              options
            )

            this.logger.log("OIDC discovery initialization completed successfully")
            return config
          },
          error => {
            this.logger.error("OIDC initialization failed", error)
            if (error instanceof Error) {
              if (error.message.includes("Incomplete manual OIDC configuration")) {
                throw error
              }

              if (error.message.includes("network") || error.message.includes("timeout")) {
                return "oidc_network_error" as const
              }
              if (error.message.includes("discovery") || error.message.includes("well-known")) {
                return "oidc_invalid_provider_response" as const
              }
            }
            return "oidc_network_error" as const
          }
        )
      )
    )
  }

  getConfiguration(): OidcServerMetadata {
    if (!this.validatedConfiguration) {
      throw new Error(
        "OIDC configuration not initialized. Service may not have completed bootstrap. This should never happen at runtime."
      )
    }
    return this.validatedConfiguration
  }

  getRawClientConfiguration(): client.Configuration {
    if (!this.rawConfiguration) {
      throw new Error(
        "OIDC raw configuration not initialized. Service may not have completed bootstrap. This should never happen at runtime."
      )
    }
    return this.rawConfiguration
  }

  private validateAndTransformConfiguration(config: client.Configuration): OidcServerMetadata {
    const rawMetadata = config.serverMetadata()

    // Validate that all required OIDC endpoints exist
    if (!rawMetadata.issuer) {
      throw new Error("OIDC configuration missing required 'issuer' field")
    }
    if (!rawMetadata.authorization_endpoint) {
      throw new Error("OIDC configuration missing required 'authorization_endpoint' field")
    }
    if (!rawMetadata.token_endpoint) {
      throw new Error("OIDC configuration missing required 'token_endpoint' field")
    }
    if (!rawMetadata.userinfo_endpoint) {
      throw new Error("OIDC configuration missing required 'userinfo_endpoint' field")
    }

    // Create validated server metadata with guaranteed non-null values
    const validatedMetadata: OidcServerMetadata = {
      issuer: rawMetadata.issuer,
      authorization_endpoint: rawMetadata.authorization_endpoint,
      token_endpoint: rawMetadata.token_endpoint,
      userinfo_endpoint: rawMetadata.userinfo_endpoint
    }

    return validatedMetadata
  }
}
